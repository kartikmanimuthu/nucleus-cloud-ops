#!/usr/bin/env npx tsx
/**
 * migrate-schedules.ts
 *
 * Migrates all schedule and execution records from DynamoDB NucleusAppTable to PostgreSQL.
 *
 * Migrates:
 *   - schedules        (GSI1: TYPE#SCHEDULE → PostgreSQL schedules table)
 *   - schedule_executions (GSI1: TYPE#EXECUTION → PostgreSQL schedule_executions table)
 *
 * Prerequisites:
 *   - docker compose up -d postgres (PostgreSQL running locally)
 *   - npm run db:migrate (schema applied, run from web-ui/)
 *   - DATABASE_URL set in environment
 *   - AWS credentials available (AWS_PROFILE=PLATFORM-ADMIN or env vars)
 *
 * Usage:
 *   AWS_PROFILE=PLATFORM-ADMIN DATABASE_URL=postgresql://postgres:postgres@localhost:5432/nucleus npx tsx scripts/migrate-schedules.ts
 *
 * Idempotent: safe to re-run — uses upsert (ON CONFLICT DO UPDATE via Prisma upsert).
 * Progress: prints "Migrated X/Y records..." after each batch.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { PrismaClient } from '@prisma/client';

// ── Configuration ─────────────────────────────────────────────────────────────

const APP_TABLE_NAME = process.env.APP_TABLE_NAME ?? process.env.DYNAMODB_TABLE_NAME;
const DATABASE_URL = process.env.DATABASE_URL;

if (!APP_TABLE_NAME) {
    console.error('ERROR: APP_TABLE_NAME (or DYNAMODB_TABLE_NAME) environment variable is required');
    process.exit(1);
}

if (!DATABASE_URL) {
    console.error('ERROR: DATABASE_URL environment variable is required');
    process.exit(1);
}

// ── Clients ───────────────────────────────────────────────────────────────────

// Credentials resolved via default provider chain (respects AWS_PROFILE env var)
const dynamoClient = DynamoDBDocumentClient.from(
    new DynamoDBClient({
        region: process.env.AWS_REGION ?? 'us-east-1',
    })
);

const prisma = new PrismaClient({
    datasources: { db: { url: DATABASE_URL } },
    log: ['error'],
});

// ── Types ─────────────────────────────────────────────────────────────────────

interface DynamoScheduleItem {
    pk?: string;
    sk?: string;
    gsi1pk?: string;
    tenantId?: string;
    scheduleId?: string;
    accountId?: string;
    name?: string;
    description?: string;
    starttime?: string;
    endtime?: string;
    timezone?: string;
    days?: string[];
    active?: boolean;
    resources?: unknown[];
    createdAt?: string;
    updatedAt?: string;
    createdBy?: string;
    updatedBy?: string;
}

interface DynamoExecutionItem {
    pk?: string;
    sk?: string;
    gsi1pk?: string;
    tenantId?: string;
    executionId?: string;
    scheduleId?: string;
    accountId?: string;
    status?: string;
    executionTime?: string;
    resourcesStarted?: number;
    resourcesStopped?: number;
    resourcesFailed?: number;
    duration?: number;
    errorMessage?: string;
    details?: unknown;
    schedule_metadata?: unknown;
    ttl?: number;
}

// ── DynamoDB Query Helper ──────────────────────────────────────────────────────

async function queryGSI1<T>(gsi1Value: string): Promise<T[]> {
    const items: T[] = [];
    let lastEvaluatedKey: Record<string, unknown> | undefined;

    do {
        const command = new QueryCommand({
            TableName: APP_TABLE_NAME as string,
            IndexName: 'GSI1',
            KeyConditionExpression: 'gsi1pk = :gsi1pk',
            ExpressionAttributeValues: {
                ':gsi1pk': gsi1Value,
            },
            ExclusiveStartKey: lastEvaluatedKey,
        });

        const response = await dynamoClient.send(command);
        items.push(...((response.Items ?? []) as T[]));
        lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;

        if (lastEvaluatedKey) {
            console.log(`  Queried ${items.length} records so far (${gsi1Value}), fetching next page...`);
        }
    } while (lastEvaluatedKey);

    return items;
}

// ── Migrate Schedules ─────────────────────────────────────────────────────────

async function migrateSchedules(): Promise<{ migrated: number; skipped: number }> {
    console.log('Querying DynamoDB for schedule records (GSI1: TYPE#SCHEDULE)...');
    const items = await queryGSI1<DynamoScheduleItem>('TYPE#SCHEDULE');
    const total = items.length;
    console.log(`Found ${total} schedule records to migrate.\n`);

    if (total === 0) {
        console.log('No schedule records to migrate.');
        return { migrated: 0, skipped: 0 };
    }

    let migrated = 0;
    let skipped = 0;

    for (const item of items) {
        const tenantId = item.tenantId ?? 'org-default';
        const scheduleId = item.scheduleId ?? item.pk?.replace('SCHEDULE#', '');

        if (!scheduleId) {
            console.warn(`  SKIP: malformed item with no scheduleId — pk=${item.pk}, sk=${item.sk}`);
            skipped += 1;
            continue;
        }

        if (!item.name) {
            console.warn(`  SKIP: schedule ${scheduleId} has no name — skipping`);
            skipped += 1;
            continue;
        }

        if (!item.starttime || !item.endtime) {
            console.warn(`  SKIP: schedule ${scheduleId} has no starttime/endtime — skipping`);
            skipped += 1;
            continue;
        }

        await prisma.schedule.upsert({
            where: {
                tenantId_scheduleId: { tenantId, scheduleId },
            },
            create: {
                tenantId,
                scheduleId,
                accountId: item.accountId ?? '',
                name: item.name,
                description: item.description ?? null,
                starttime: item.starttime,
                endtime: item.endtime,
                timezone: item.timezone ?? 'UTC',
                days: Array.isArray(item.days) ? item.days : [],
                active: item.active ?? true,
                resources: (item.resources as object[]) ?? [],
                createdAt: item.createdAt ? new Date(item.createdAt) : new Date(),
                updatedAt: item.updatedAt ? new Date(item.updatedAt) : new Date(),
                createdBy: item.createdBy ?? 'migration',
                updatedBy: item.updatedBy ?? 'migration',
            },
            update: {
                name: item.name,
                description: item.description ?? null,
                active: item.active ?? true,
                resources: (item.resources as object[]) ?? [],
                updatedAt: item.updatedAt ? new Date(item.updatedAt) : new Date(),
                updatedBy: item.updatedBy ?? 'migration',
            },
        });

        migrated += 1;
        console.log(`Migrated ${migrated}/${total} records... (scheduleId=${scheduleId}, tenantId=${tenantId})`);
    }

    return { migrated, skipped };
}

// ── Migrate Schedule Executions ───────────────────────────────────────────────

async function migrateExecutions(): Promise<{ migrated: number; skipped: number }> {
    console.log('\nQuerying DynamoDB for execution records (GSI1: TYPE#EXECUTION)...');
    const items = await queryGSI1<DynamoExecutionItem>('TYPE#EXECUTION');
    const total = items.length;
    console.log(`Found ${total} execution records to migrate.\n`);

    if (total === 0) {
        console.log('No execution records to migrate.');
        return { migrated: 0, skipped: 0 };
    }

    let migrated = 0;
    let skipped = 0;

    for (const item of items) {
        const tenantId = item.tenantId ?? 'org-default';
        const executionId = item.executionId ?? item.pk?.replace('EXECUTION#', '');

        if (!executionId) {
            console.warn(`  SKIP: malformed item with no executionId — pk=${item.pk}, sk=${item.sk}`);
            skipped += 1;
            continue;
        }

        const scheduleId = item.scheduleId ?? '';
        const accountId = item.accountId ?? '';
        const status = item.status ?? 'unknown';
        const executionTime = item.executionTime
            ? new Date(item.executionTime)
            : new Date();

        // TTL conversion: item.ttl is epoch seconds → DateTime
        // If missing or in the past, set to now + 90 days
        const ttlDate = item.ttl ? new Date(item.ttl * 1000) : null;
        const expiresAt =
            ttlDate && ttlDate > new Date()
                ? ttlDate
                : new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

        await prisma.scheduleExecution.upsert({
            where: {
                tenantId_executionId: { tenantId, executionId },
            },
            create: {
                tenantId,
                executionId,
                scheduleId,
                accountId,
                status,
                executionTime,
                resourcesStarted: item.resourcesStarted ?? 0,
                resourcesStopped: item.resourcesStopped ?? 0,
                resourcesFailed: item.resourcesFailed ?? 0,
                duration: item.duration ?? null,
                errorMessage: item.errorMessage ?? null,
                details: (item.details as object) ?? null,
                scheduleMetadata: (item.schedule_metadata as object) ?? null,
                expiresAt,
            },
            update: {
                status,
                resourcesStarted: item.resourcesStarted ?? 0,
                resourcesStopped: item.resourcesStopped ?? 0,
                resourcesFailed: item.resourcesFailed ?? 0,
                duration: item.duration ?? null,
                errorMessage: item.errorMessage ?? null,
                details: (item.details as object) ?? null,
                scheduleMetadata: (item.schedule_metadata as object) ?? null,
                expiresAt,
            },
        });

        migrated += 1;
        console.log(`Migrated ${migrated}/${total} records... (executionId=${executionId}, tenantId=${tenantId})`);
    }

    return { migrated, skipped };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function migrate(): Promise<void> {
    console.log('Starting schedule migration: DynamoDB -> PostgreSQL');
    console.log(`  Source table: ${APP_TABLE_NAME}`);
    console.log(`  AWS_PROFILE: ${process.env.AWS_PROFILE ?? '(default)'}`);
    console.log('');

    const scheduleResult = await migrateSchedules();
    const executionResult = await migrateExecutions();

    console.log('\n─────────────────────────────────────────────────');
    console.log('Migration Summary:');
    console.log(`  Schedules:   ${scheduleResult.migrated} migrated, ${scheduleResult.skipped} skipped.`);
    console.log(`  Executions:  ${executionResult.migrated} migrated, ${executionResult.skipped} skipped.`);
    console.log('─────────────────────────────────────────────────');
}

// ── Entry Point ───────────────────────────────────────────────────────────────

migrate()
    .catch((error: unknown) => {
        console.error('Migration failed:', error);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
