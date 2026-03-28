#!/usr/bin/env npx tsx
/**
 * migrate-inventory.ts
 *
 * Migrates inventory resources from DynamoDB inventory table to PostgreSQL
 * inventory_resources table. Also migrates inventory vector keys from
 * NucleusAppTable (INVENTORY_VECTORS#<accountId>) to inventory_vector_keys table.
 *
 * Prerequisites:
 *   - docker compose up -d postgres
 *   - npm run db:migrate (schema applied)
 *   - DATABASE_URL set
 *   - AWS credentials (AWS_PROFILE=PLATFORM-ADMIN)
 *
 * Usage:
 *   AWS_PROFILE=PLATFORM-ADMIN DATABASE_URL=postgresql://postgres:postgres@localhost:5432/nucleus \
 *     INVENTORY_TABLE_NAME=nucleus-app-inventory-table \
 *     APP_TABLE_NAME=nucleus-app-app-table \
 *     npx tsx scripts/migrate-inventory.ts
 *
 * Idempotent: uses Prisma upsert (ON CONFLICT DO UPDATE).
 * Progress: prints "Migrated X/Y records..." after each batch.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { PrismaClient } from '@prisma/client';

// ── Configuration ─────────────────────────────────────────────────────────────

const INVENTORY_TABLE_NAME = process.env.INVENTORY_TABLE_NAME;
const APP_TABLE_NAME = process.env.APP_TABLE_NAME ?? process.env.DYNAMODB_TABLE_NAME;
const DATABASE_URL = process.env.DATABASE_URL;
const BATCH_SIZE = 500;

if (!INVENTORY_TABLE_NAME) {
    console.error('ERROR: INVENTORY_TABLE_NAME environment variable is required');
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

interface DynamoInventoryItem {
    pk?: string;
    sk?: string;
    gsi1pk?: string;
    accountId?: string;
    region?: string;
    resourceType?: string;
    resourceId?: string;
    name?: string;
    state?: string;
    status?: string;
    tags?: unknown;
    Metadata?: unknown;
    RawMetadata?: unknown;
    metadata?: unknown;
    lastDiscoveredAt?: string;
    tenantId?: string;
}

interface DynamoVectorKeyItem {
    pk?: string;
    sk?: string;
    vectorKeys?: string[];
}

// ── Migrate Inventory Resources ───────────────────────────────────────────────

async function migrateInventoryResources(): Promise<number> {
    console.log(`Scanning DynamoDB inventory table: ${INVENTORY_TABLE_NAME}`);

    const items: DynamoInventoryItem[] = [];
    let lastEvaluatedKey: Record<string, unknown> | undefined;

    do {
        const response = await dynamoClient.send(new ScanCommand({
            TableName: INVENTORY_TABLE_NAME as string,
            ExclusiveStartKey: lastEvaluatedKey,
        }));
        items.push(...((response.Items ?? []) as DynamoInventoryItem[]));
        lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
        if (lastEvaluatedKey) {
            console.log(`  Scanned ${items.length} inventory records so far, fetching next page...`);
        }
    } while (lastEvaluatedKey);

    const total = items.length;
    console.log(`Found ${total} inventory resource records to migrate.\n`);

    if (total === 0) {
        console.log('No inventory resources to migrate.');
        return 0;
    }

    let migrated = 0;
    let skipped = 0;

    for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const batch = items.slice(i, i + BATCH_SIZE);

        for (const item of batch) {
            // Extract tenantId from PK pattern TENANT#<tenantId>#ACCOUNT#<accountId>
            // or fall back to item.tenantId or 'default'
            let tenantId = item.tenantId ?? 'default';
            if (!item.tenantId && item.pk) {
                const tenantMatch = item.pk.match(/^TENANT#([^#]+)/);
                if (tenantMatch) tenantId = tenantMatch[1];
            }

            const accountId = item.accountId;
            const region = item.region;
            const resourceType = item.resourceType;
            const resourceId = item.resourceId;

            if (!accountId || !region || !resourceType || !resourceId) {
                console.warn(`  SKIP: incomplete inventory item — pk=${item.pk}, sk=${item.sk}`);
                skipped += 1;
                continue;
            }

            try {
                await prisma.inventoryResource.upsert({
                    where: {
                        tenantId_accountId_resourceType_resourceId: {
                            tenantId,
                            accountId,
                            resourceType,
                            resourceId,
                        },
                    },
                    create: {
                        tenantId,
                        accountId,
                        region,
                        resourceType,
                        resourceId,
                        name: item.name ?? null,
                        status: item.status ?? item.state ?? null,
                        tags: (item.tags as object) ?? {},
                        metadata: (item.Metadata ?? item.RawMetadata ?? item.metadata as object) ?? {},
                        discoveredAt: item.lastDiscoveredAt ? new Date(item.lastDiscoveredAt) : new Date(),
                    },
                    update: {
                        region,
                        name: item.name ?? null,
                        status: item.status ?? item.state ?? null,
                        tags: (item.tags as object) ?? {},
                        metadata: (item.Metadata ?? item.RawMetadata ?? item.metadata as object) ?? {},
                        discoveredAt: item.lastDiscoveredAt ? new Date(item.lastDiscoveredAt) : new Date(),
                    },
                });
                migrated += 1;
            } catch (err) {
                console.error(`  ERROR: failed to upsert resource ${resourceType}/${resourceId}:`, err);
                skipped += 1;
            }
        }

        console.log(`Migrated ${migrated}/${total} inventory resources...`);
    }

    console.log(`\nInventory resources: ${migrated} migrated, ${skipped} skipped.\n`);
    return migrated;
}

// ── Migrate Vector Keys ───────────────────────────────────────────────────────

async function migrateVectorKeys(): Promise<number> {
    if (!APP_TABLE_NAME) {
        console.log('APP_TABLE_NAME not set — skipping vector key migration.');
        return 0;
    }

    console.log(`Scanning DynamoDB app table for INVENTORY_VECTORS# records: ${APP_TABLE_NAME}`);

    const items: DynamoVectorKeyItem[] = [];
    let lastEvaluatedKey: Record<string, unknown> | undefined;

    do {
        const response = await dynamoClient.send(new ScanCommand({
            TableName: APP_TABLE_NAME,
            FilterExpression: 'begins_with(pk, :prefix)',
            ExpressionAttributeValues: { ':prefix': 'INVENTORY_VECTORS#' },
            ExclusiveStartKey: lastEvaluatedKey,
        }));
        items.push(...((response.Items ?? []) as DynamoVectorKeyItem[]));
        lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastEvaluatedKey);

    const total = items.length;
    console.log(`Found ${total} vector key records to migrate.\n`);

    if (total === 0) {
        console.log('No vector key records to migrate.');
        return 0;
    }

    let migrated = 0;
    let skipped = 0;

    for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const batch = items.slice(i, i + BATCH_SIZE);

        for (const item of batch) {
            const accountId = item.pk?.replace('INVENTORY_VECTORS#', '');
            if (!accountId) {
                console.warn(`  SKIP: could not extract accountId from pk=${item.pk}`);
                skipped += 1;
                continue;
            }

            try {
                await prisma.inventoryVectorKey.upsert({
                    where: { accountId },
                    create: {
                        accountId,
                        vectorKeys: item.vectorKeys ?? [],
                    },
                    update: {
                        vectorKeys: item.vectorKeys ?? [],
                    },
                });
                migrated += 1;
            } catch (err) {
                console.error(`  ERROR: failed to upsert vector keys for account ${accountId}:`, err);
                skipped += 1;
            }
        }

        console.log(`Migrated ${migrated}/${total} vector key records...`);
    }

    console.log(`\nVector keys: ${migrated} migrated, ${skipped} skipped.\n`);
    return migrated;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    console.log('=== migrate-inventory.ts ===\n');

    try {
        const resourceCount = await migrateInventoryResources();
        const vectorKeyCount = await migrateVectorKeys();

        console.log('=== Migration complete ===');
        console.log(`  Inventory resources migrated: ${resourceCount}`);
        console.log(`  Vector key records migrated:  ${vectorKeyCount}`);
    } finally {
        await prisma.$disconnect();
    }
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
