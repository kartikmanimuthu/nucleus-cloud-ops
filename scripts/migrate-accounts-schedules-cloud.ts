#!/usr/bin/env npx tsx
/**
 * migrate-accounts-schedules-cloud.ts
 *
 * Migrates ONLY accounts and schedules from DynamoDB → cloud PostgreSQL (via SSM tunnel).
 *
 * All records are written under the tenant that exists in the target DB.
 * The tenant ID is queried from the DB at startup and confirmed before any writes.
 *
 * Usage:
 *   AWS_PROFILE=STX-CLOUD-PLATFORM \
 *   APP_TABLE_NAME=nucleus-app-app-table \
 *   AWS_REGION=ap-south-1 \
 *   DATABASE_URL="postgresql://nucleus_admin:<pass>@localhost:5433/nucleus?sslmode=require&uselibpqcompat=true" \
 *   npx tsx scripts/migrate-accounts-schedules-cloud.ts
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { PrismaClient } from '@prisma/client';

// ── Config ────────────────────────────────────────────────────────────────────

const APP_TABLE_NAME = process.env.APP_TABLE_NAME ?? process.env.DYNAMODB_TABLE_NAME;
const DATABASE_URL = process.env.DATABASE_URL;

if (!APP_TABLE_NAME) {
    console.error('ERROR: APP_TABLE_NAME env var is required');
    process.exit(1);
}
if (!DATABASE_URL) {
    console.error('ERROR: DATABASE_URL env var is required');
    process.exit(1);
}

// ── Clients ───────────────────────────────────────────────────────────────────

const dynamo = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: process.env.AWS_REGION ?? 'ap-south-1' })
);

const prisma = new PrismaClient({
    datasources: { db: { url: DATABASE_URL } },
    log: ['error'],
});

// ── Types ─────────────────────────────────────────────────────────────────────

interface DynamoAccountItem {
    pk?: string; sk?: string; tenantId?: string; accountId?: string;
    accountName?: string; roleArn?: string; externalId?: string;
    regions?: string[]; active?: boolean; description?: string;
    connectionStatus?: string; connectionError?: string;
    createdAt?: string; updatedAt?: string; createdBy?: string; updatedBy?: string;
}

interface DynamoScheduleItem {
    pk?: string; sk?: string; tenantId?: string; scheduleId?: string;
    accountId?: string; name?: string; description?: string;
    starttime?: string; endtime?: string; timezone?: string;
    days?: string[]; active?: boolean; resources?: unknown[];
    createdAt?: string; updatedAt?: string; createdBy?: string; updatedBy?: string;
}

// ── DynamoDB helper ───────────────────────────────────────────────────────────

async function queryGSI1<T>(gsi1Value: string): Promise<T[]> {
    const items: T[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
        const res = await dynamo.send(new QueryCommand({
            TableName: APP_TABLE_NAME as string,
            IndexName: 'GSI1',
            KeyConditionExpression: 'gsi1pk = :v',
            ExpressionAttributeValues: { ':v': gsi1Value },
            ExclusiveStartKey: lastKey,
        }));
        items.push(...((res.Items ?? []) as T[]));
        lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
        if (lastKey) console.log(`  ...${items.length} fetched so far (${gsi1Value})`);
    } while (lastKey);
    return items;
}

// ── Migrate accounts ──────────────────────────────────────────────────────────

async function migrateAccounts(tenantId: string): Promise<void> {
    console.log('\n── Accounts ─────────────────────────────────────────────');
    const items = await queryGSI1<DynamoAccountItem>('TYPE#ACCOUNT');
    console.log(`Found ${items.length} account records in DynamoDB.`);
    if (items.length === 0) return;

    let migrated = 0, skipped = 0;
    for (const item of items) {
        const accountId = item.accountId ?? item.pk?.replace('ACCOUNT#', '');
        if (!accountId) {
            console.warn(`  SKIP: no accountId — pk=${item.pk}`);
            skipped++;
            continue;
        }

        await prisma.account.upsert({
            where: { tenantId_accountId: { tenantId, accountId } },
            create: {
                tenantId,
                accountId,
                name: item.accountName ?? accountId,
                roleArn: item.roleArn ?? '',
                externalId: item.externalId ?? null,
                regions: item.regions ?? [],
                active: item.active ?? true,
                description: item.description ?? null,
                connectionStatus: item.connectionStatus ?? 'unknown',
                connectionError: item.connectionError ?? null,
                createdAt: item.createdAt ? new Date(item.createdAt) : new Date(),
                updatedAt: item.updatedAt ? new Date(item.updatedAt) : new Date(),
                createdBy: item.createdBy ?? 'migration',
                updatedBy: item.updatedBy ?? 'migration',
            },
            update: {
                name: item.accountName ?? accountId,
                roleArn: item.roleArn ?? '',
                externalId: item.externalId ?? null,
                regions: item.regions ?? [],
                active: item.active ?? true,
                description: item.description ?? null,
                connectionStatus: item.connectionStatus ?? 'unknown',
                connectionError: item.connectionError ?? null,
                updatedAt: item.updatedAt ? new Date(item.updatedAt) : new Date(),
                updatedBy: item.updatedBy ?? 'migration',
            },
        });
        migrated++;
        console.log(`  [${migrated}/${items.length}] accountId=${accountId}`);
    }
    console.log(`Accounts done: ${migrated} migrated, ${skipped} skipped.`);
}

// ── Migrate schedules ─────────────────────────────────────────────────────────

async function migrateSchedules(tenantId: string): Promise<void> {
    console.log('\n── Schedules ────────────────────────────────────────────');
    const items = await queryGSI1<DynamoScheduleItem>('TYPE#SCHEDULE');
    console.log(`Found ${items.length} schedule records in DynamoDB.`);
    if (items.length === 0) return;

    let migrated = 0, skipped = 0;
    for (const item of items) {
        const scheduleId = item.scheduleId ?? item.pk?.replace('SCHEDULE#', '');
        if (!scheduleId) {
            console.warn(`  SKIP: no scheduleId — pk=${item.pk}`);
            skipped++;
            continue;
        }
        if (!item.name) {
            console.warn(`  SKIP: schedule ${scheduleId} has no name`);
            skipped++;
            continue;
        }
        if (!item.starttime || !item.endtime) {
            console.warn(`  SKIP: schedule ${scheduleId} missing starttime/endtime`);
            skipped++;
            continue;
        }

        await prisma.schedule.upsert({
            where: { tenantId_scheduleId: { tenantId, scheduleId } },
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
        migrated++;
        console.log(`  [${migrated}/${items.length}] scheduleId=${scheduleId}`);
    }
    console.log(`Schedules done: ${migrated} migrated, ${skipped} skipped.`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log('DynamoDB → PostgreSQL (cloud) — accounts + schedules only');
    console.log(`  DynamoDB table : ${APP_TABLE_NAME}`);
    console.log(`  AWS region     : ${process.env.AWS_REGION ?? 'ap-south-1'}`);
    console.log(`  AWS profile    : ${process.env.AWS_PROFILE ?? '(default)'}`);

    // Confirm tenant exists in target DB
    const tenants = await prisma.tenant.findMany({ select: { id: true, name: true, slug: true } });
    if (tenants.length === 0) {
        console.error('ERROR: No tenants found in target database. Aborting.');
        process.exit(1);
    }
    console.log('\nTenants found in target DB:');
    tenants.forEach(t => console.log(`  id=${t.id}  name=${t.name}  slug=${t.slug}`));

    // Use the first (and only) tenant
    const tenant = tenants[0];
    console.log(`\nUsing tenant: id=${tenant.id}  name=${tenant.name}`);
    console.log('─────────────────────────────────────────────────────────\n');

    await migrateAccounts(tenant.id);
    await migrateSchedules(tenant.id);

    console.log('\n═════════════════════════════════════════════════════════');
    console.log('Migration complete.');
    console.log('═════════════════════════════════════════════════════════');
}

main()
    .catch(e => { console.error('Migration failed:', e); process.exit(1); })
    .finally(() => prisma.$disconnect());
