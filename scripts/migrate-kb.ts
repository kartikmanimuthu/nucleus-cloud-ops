#!/usr/bin/env npx tsx
/**
 * migrate-kb.ts
 *
 * Migrates all Knowledge Base and Data Source records from DynamoDB NucleusAppTable
 * to PostgreSQL knowledge_bases and data_sources tables.
 *
 * Migrates:
 *   - knowledge_bases  (GSI1: TYPE#KNOWLEDGE_BASE → PostgreSQL knowledge_bases table)
 *   - data_sources     (PK=KB#<kbId>, SK begins_with DATASOURCE# → PostgreSQL data_sources table)
 *
 * Prerequisites:
 *   - docker compose up -d postgres (PostgreSQL running locally)
 *   - npm run db:migrate (schema applied, run from web-ui/)
 *   - DATABASE_URL set in environment
 *   - AWS credentials available (AWS_PROFILE=PLATFORM-ADMIN or env vars)
 *
 * Usage:
 *   AWS_PROFILE=PLATFORM-ADMIN DATABASE_URL=postgresql://postgres:postgres@localhost:5432/nucleus npx tsx scripts/migrate-kb.ts
 *
 * Idempotent: safe to re-run — uses upsert (ON CONFLICT DO UPDATE via Prisma upsert).
 * Progress: prints "Migrated X/Y records..." after each record.
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

interface DynamoKBItem {
    pk?: string;
    sk?: string;
    gsi1pk?: string;
    id?: string;
    tenantId?: string;
    name?: string;
    description?: string;
    status?: string;
    vectorCount?: number;
    dataSourceCount?: number;
    createdAt?: string;
    updatedAt?: string;
    createdBy?: string;
}

interface DynamoDataSourceItem {
    pk?: string;
    sk?: string;
    id?: string;
    tenantId?: string;
    knowledgeBaseId?: string;
    name?: string;
    sourceType?: string;
    status?: string;
    config?: unknown;
    vectorCount?: number;
    vectorKeys?: string[];
    lastSyncAt?: string;
    lastSyncError?: string;
    createdAt?: string;
    updatedAt?: string;
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

async function queryDataSources(kbId: string): Promise<DynamoDataSourceItem[]> {
    const items: DynamoDataSourceItem[] = [];
    let lastEvaluatedKey: Record<string, unknown> | undefined;

    do {
        const command = new QueryCommand({
            TableName: APP_TABLE_NAME as string,
            KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
            ExpressionAttributeValues: {
                ':pk': `KB#${kbId}`,
                ':skPrefix': 'DATASOURCE#',
            },
            ExclusiveStartKey: lastEvaluatedKey,
        });

        const response = await dynamoClient.send(command);
        items.push(...((response.Items ?? []) as DynamoDataSourceItem[]));
        lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastEvaluatedKey);

    return items;
}

// ── Migrate Knowledge Bases ───────────────────────────────────────────────────

async function migrateKnowledgeBases(): Promise<{
    migrated: number;
    skipped: number;
    kbTenantMap: Map<string, string>;
}> {
    console.log('Querying DynamoDB for knowledge base records (GSI1: TYPE#KNOWLEDGE_BASE)...');
    const items = await queryGSI1<DynamoKBItem>('TYPE#KNOWLEDGE_BASE');
    const total = items.length;
    console.log(`Found ${total} knowledge base records to migrate.\n`);

    const kbTenantMap = new Map<string, string>();

    if (total === 0) {
        console.log('No knowledge base records to migrate.');
        return { migrated: 0, skipped: 0, kbTenantMap };
    }

    let migrated = 0;
    let skipped = 0;

    for (const item of items) {
        const tenantId = item.tenantId ?? 'org-default';
        // id is stored directly on the item; fallback to extracting from sk
        const kbId = item.id ?? item.sk?.replace('KB#', '');

        if (!kbId) {
            console.warn(`  SKIP: malformed KB item with no id — pk=${item.pk}, sk=${item.sk}`);
            skipped += 1;
            continue;
        }

        if (!item.name) {
            console.warn(`  SKIP: KB ${kbId} has no name — skipping`);
            skipped += 1;
            continue;
        }

        // Build kbId -> tenantId map for data source migration
        kbTenantMap.set(kbId, tenantId);

        await prisma.knowledgeBase.upsert({
            where: { id: kbId },
            create: {
                id: kbId,
                tenantId,
                name: item.name,
                description: item.description ?? null,
                status: item.status ?? 'active',
                vectorCount: item.vectorCount ?? 0,
                dataSourceCount: item.dataSourceCount ?? 0,
                createdAt: item.createdAt ? new Date(item.createdAt) : new Date(),
                updatedAt: item.updatedAt ? new Date(item.updatedAt) : new Date(),
                createdBy: item.createdBy ?? null,
            },
            update: {
                name: item.name,
                description: item.description ?? null,
                status: item.status ?? 'active',
                vectorCount: item.vectorCount ?? 0,
                dataSourceCount: item.dataSourceCount ?? 0,
                updatedAt: item.updatedAt ? new Date(item.updatedAt) : new Date(),
            },
        });

        migrated += 1;
        console.log(`Migrated ${migrated}/${total} knowledge bases... (kbId=${kbId}, tenantId=${tenantId})`);
    }

    return { migrated, skipped, kbTenantMap };
}

// ── Migrate Data Sources ──────────────────────────────────────────────────────

async function migrateDataSources(kbTenantMap: Map<string, string>): Promise<{
    migrated: number;
    skipped: number;
}> {
    console.log('\nQuerying DynamoDB for data source records (PK=KB#<kbId>, SK begins_with DATASOURCE#)...');

    let migrated = 0;
    let skipped = 0;
    let totalKbs = 0;

    for (const [kbId, tenantId] of Array.from(kbTenantMap.entries())) {
        const items = await queryDataSources(kbId);
        totalKbs += 1;

        for (const item of items) {
            const dsId = item.id ?? item.sk?.replace('DATASOURCE#', '');

            if (!dsId) {
                console.warn(`  SKIP: malformed DataSource item with no id — pk=${item.pk}, sk=${item.sk}`);
                skipped += 1;
                continue;
            }

            if (!item.name) {
                console.warn(`  SKIP: DataSource ${dsId} has no name — skipping`);
                skipped += 1;
                continue;
            }

            await prisma.dataSource.upsert({
                where: { id: dsId },
                create: {
                    id: dsId,
                    tenantId,
                    knowledgeBaseId: kbId,
                    name: item.name,
                    sourceType: item.sourceType ?? 'file-upload',
                    status: item.status ?? 'pending',
                    config: (item.config as object) ?? {},
                    vectorCount: item.vectorCount ?? 0,
                    vectorKeys: item.vectorKeys ?? [],
                    lastSyncAt: item.lastSyncAt ? new Date(item.lastSyncAt) : null,
                    lastSyncError: item.lastSyncError ?? null,
                    createdAt: item.createdAt ? new Date(item.createdAt) : new Date(),
                    updatedAt: item.updatedAt ? new Date(item.updatedAt) : new Date(),
                },
                update: {
                    name: item.name,
                    status: item.status ?? 'pending',
                    config: (item.config as object) ?? {},
                    vectorCount: item.vectorCount ?? 0,
                    vectorKeys: item.vectorKeys ?? [],
                    lastSyncAt: item.lastSyncAt ? new Date(item.lastSyncAt) : null,
                    lastSyncError: item.lastSyncError ?? null,
                    updatedAt: item.updatedAt ? new Date(item.updatedAt) : new Date(),
                },
            });

            migrated += 1;
            console.log(`Migrated ${migrated} data sources... (dsId=${dsId}, kbId=${kbId})`);
        }
    }

    console.log(`\nProcessed data sources for ${totalKbs} knowledge bases.`);
    return { migrated, skipped };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function migrate(): Promise<void> {
    console.log('Starting KB migration: DynamoDB -> PostgreSQL');
    console.log(`  Source table: ${APP_TABLE_NAME}`);
    console.log(`  AWS_PROFILE: ${process.env.AWS_PROFILE ?? '(default)'}`);
    console.log('');

    const kbResult = await migrateKnowledgeBases();
    const dsResult = await migrateDataSources(kbResult.kbTenantMap);

    console.log('\n─────────────────────────────────────────────────');
    console.log('Migration Summary:');
    console.log(`  Knowledge Bases: ${kbResult.migrated} migrated, ${kbResult.skipped} skipped.`);
    console.log(`  Data Sources:    ${dsResult.migrated} migrated, ${dsResult.skipped} skipped.`);
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
