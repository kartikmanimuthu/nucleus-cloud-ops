#!/usr/bin/env npx tsx
/**
 * migrate-tenant-configs.ts
 *
 * Migrates all tenant config records from DynamoDB to PostgreSQL.
 *
 * Prerequisites:
 *   - docker compose up -d postgres (PostgreSQL running locally)
 *   - npm run db:migrate (schema applied, run from web-ui/)
 *   - DATABASE_URL set in environment
 *   - AWS credentials available (AWS_PROFILE=PLATFORM-ADMIN or env vars)
 *
 * Usage:
 *   AWS_PROFILE=PLATFORM-ADMIN DATABASE_URL=postgresql://postgres:postgres@localhost:5432/nucleus npx tsx scripts/migrate-tenant-configs.ts
 *
 * Idempotent: safe to re-run — uses upsert (ON CONFLICT DO UPDATE).
 * Progress: prints "Migrated X/Y records..." after each upsert.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
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

interface DynamoTenantConfigItem {
    pk: string;
    sk: string;
    tenantId: string;
    configKey: string;
    data: unknown;
    updatedAt?: string;
    updatedBy?: string;
}

// ── DynamoDB Scan ─────────────────────────────────────────────────────────────

async function scanAllTenantConfigs(): Promise<DynamoTenantConfigItem[]> {
    const items: DynamoTenantConfigItem[] = [];
    let lastEvaluatedKey: Record<string, unknown> | undefined;

    do {
        const command = new ScanCommand({
            TableName: APP_TABLE_NAME as string,
            FilterExpression: 'begins_with(sk, :skPrefix)',
            ExpressionAttributeValues: {
                ':skPrefix': 'CONFIG#',
            },
            ExclusiveStartKey: lastEvaluatedKey,
        });

        const response = await dynamoClient.send(command);
        items.push(...((response.Items ?? []) as DynamoTenantConfigItem[]));
        lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;

        if (lastEvaluatedKey) {
            console.log(`  Scanned ${items.length} records so far, fetching next page...`);
        }
    } while (lastEvaluatedKey);

    return items;
}

// ── Migration Logic ───────────────────────────────────────────────────────────

async function ensureTenantExists(tenantId: string): Promise<void> {
    // The tenant_configs table has a FK to tenants.id.
    // Upsert the tenant row so the config FK constraint is satisfied.
    await prisma.tenant.upsert({
        where: { id: tenantId },
        update: {},
        create: {
            id: tenantId,
            name: tenantId, // Use tenantId as name placeholder — can be updated later
        },
    });
}

async function migrate(): Promise<void> {
    console.log('Starting tenant config migration: DynamoDB -> PostgreSQL');
    console.log(`  Source table: ${APP_TABLE_NAME}`);
    console.log(`  AWS_PROFILE: ${process.env.AWS_PROFILE ?? '(default)'}`);
    console.log('');

    // Step 1: Scan all tenant config records from DynamoDB
    console.log('Scanning DynamoDB for tenant config records...');
    const items = await scanAllTenantConfigs();
    const total = items.length;
    console.log(`Found ${total} tenant config records to migrate.\n`);

    if (total === 0) {
        console.log('No records to migrate. Exiting.');
        return;
    }

    // Step 2: Upsert each record into PostgreSQL
    // Track seen tenantIds to avoid redundant tenant upserts
    const seenTenants = new Set<string>();
    let count = 0;

    for (const item of items) {
        const tenantId = item.tenantId ?? item.pk.replace('TENANT#', '');
        const configKey = item.configKey ?? item.sk.replace('CONFIG#', '');

        if (!tenantId || !configKey) {
            console.warn(`  SKIP: malformed item — pk=${item.pk}, sk=${item.sk}`);
            continue;
        }

        // Ensure parent tenant row exists (FK constraint on tenant_configs.tenantId)
        if (!seenTenants.has(tenantId)) {
            await ensureTenantExists(tenantId);
            seenTenants.add(tenantId);
        }

        // Upsert the config record (idempotent — ON CONFLICT DO UPDATE via Prisma)
        await prisma.tenantConfig.upsert({
            where: {
                tenantId_configKey: { tenantId, configKey },
            },
            update: {
                data: (item.data ?? {}) as object,
                updatedBy: item.updatedBy ?? 'migration',
            },
            create: {
                tenantId,
                configKey,
                data: (item.data ?? {}) as object,
                updatedBy: item.updatedBy ?? 'migration',
            },
        });

        count += 1;
        console.log(`Migrated ${count}/${total} records... (configKey=${configKey}, tenantId=${tenantId})`);
    }

    console.log(`\nMigration complete. Migrated ${total} tenant config records.`);
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
