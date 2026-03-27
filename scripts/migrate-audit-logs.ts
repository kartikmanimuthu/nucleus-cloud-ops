#!/usr/bin/env npx tsx
/**
 * migrate-audit-logs.ts
 *
 * Migrates all audit log records from DynamoDB NucleusAuditTable (GSI1: TYPE#LOG)
 * to PostgreSQL audit_logs table.
 *
 * Uses batched inserts of 500 records for efficiency.
 * skipDuplicates=true makes this idempotent — safe to re-run.
 *
 * Prerequisites:
 *   - docker compose up -d postgres (PostgreSQL running locally)
 *   - npm run db:migrate (schema applied, run from web-ui/)
 *   - DATABASE_URL set in environment
 *   - AWS credentials available (AWS_PROFILE=PLATFORM-ADMIN or env vars)
 *
 * Usage:
 *   AWS_PROFILE=PLATFORM-ADMIN AUDIT_TABLE_NAME=NucleusAuditTable DATABASE_URL=postgresql://postgres:postgres@localhost:5432/nucleus npx tsx scripts/migrate-audit-logs.ts
 *
 * Idempotent: safe to re-run — uses createMany with skipDuplicates (ON CONFLICT DO NOTHING via Prisma).
 * Progress: prints "Migrated X/Y records..." after each batch of 500.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { PrismaClient } from '@prisma/client';

// ── Configuration ─────────────────────────────────────────────────────────────

const AUDIT_TABLE_NAME = process.env.AUDIT_TABLE_NAME ?? process.env.DYNAMODB_AUDIT_TABLE_NAME;
const DATABASE_URL = process.env.DATABASE_URL;
const BATCH_SIZE = 500;

if (!AUDIT_TABLE_NAME) {
    console.error('ERROR: AUDIT_TABLE_NAME (or DYNAMODB_AUDIT_TABLE_NAME) environment variable is required');
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

interface DynamoAuditLogItem {
    pk?: string;
    sk?: string;
    gsi1pk?: string;
    id?: string;
    logId?: string;
    tenantId?: string;
    timestamp?: string;
    eventType?: string;
    action?: string;
    user?: string;
    userType?: string;
    resource?: string;
    resourceType?: string;
    resourceId?: string;
    status?: string;
    severity?: string;
    details?: string;
    metadata?: unknown;
    ipAddress?: string;
    userAgent?: string;
    sessionId?: string;
    correlationId?: string;
    executionId?: string;
    region?: string;
    accountId?: string;
    duration?: number;
    errorCode?: string;
    source?: string;
    expire_at?: number; // DynamoDB TTL (epoch seconds)
}

// ── DynamoDB Query (GSI1: TYPE#LOG) ──────────────────────────────────────────

async function queryAllAuditLogs(): Promise<DynamoAuditLogItem[]> {
    const items: DynamoAuditLogItem[] = [];
    let lastEvaluatedKey: Record<string, unknown> | undefined;

    do {
        const command = new QueryCommand({
            TableName: AUDIT_TABLE_NAME as string,
            IndexName: 'GSI1',
            KeyConditionExpression: 'gsi1pk = :typeVal',
            ExpressionAttributeValues: {
                ':typeVal': 'TYPE#LOG',
            },
            ExclusiveStartKey: lastEvaluatedKey,
        });

        const response = await dynamoClient.send(command);
        items.push(...((response.Items ?? []) as DynamoAuditLogItem[]));
        lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;

        if (lastEvaluatedKey) {
            console.log(`  Queried ${items.length} records so far, fetching next page...`);
        }
    } while (lastEvaluatedKey);

    return items;
}

// ── Migration Logic ───────────────────────────────────────────────────────────

async function migrate(): Promise<void> {
    console.log('Starting audit log migration: DynamoDB -> PostgreSQL');
    console.log(`  Source table: ${AUDIT_TABLE_NAME} (GSI1: TYPE#LOG)`);
    console.log(`  AWS_PROFILE: ${process.env.AWS_PROFILE ?? '(default)'}`);
    console.log(`  Batch size: ${BATCH_SIZE}`);
    console.log('');

    // Step 1: Query all audit log records from DynamoDB via GSI1 (with full pagination)
    console.log('Querying DynamoDB for audit log records (GSI1: TYPE#LOG)...');
    const allItems = await queryAllAuditLogs();
    const total = allItems.length;
    console.log(`Found ${total} audit log records to migrate.\n`);

    if (total === 0) {
        console.log('No records to migrate. Exiting.');
        return;
    }

    // Step 2: Process in batches of 500 using createMany with skipDuplicates
    let processedCount = 0;

    for (let i = 0; i < allItems.length; i += BATCH_SIZE) {
        const batch = allItems.slice(i, i + BATCH_SIZE);

        await prisma.auditLog.createMany({
            data: batch.map((item) => {
                // TTL conversion: expire_at is epoch seconds → DateTime
                // If missing or already expired, set default 30-day retention
                const expireDate = item.expire_at ? new Date(item.expire_at * 1000) : null;
                const expiresAt =
                    expireDate && expireDate > new Date()
                        ? expireDate
                        : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

                // Derive logId from multiple possible field names
                const logId =
                    item.logId ??
                    item.id ??
                    `log-migrated-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

                return {
                    tenantId: item.tenantId ?? 'org-default',
                    logId,
                    timestamp: item.timestamp ? new Date(item.timestamp) : new Date(),
                    eventType: item.eventType ?? 'unknown',
                    action: item.action ?? 'unknown',
                    user: item.user ?? 'system',
                    userType: item.userType ?? 'system',
                    resource: item.resource ?? null,
                    resourceType: item.resourceType ?? null,
                    resourceId: item.resourceId ?? null,
                    status: item.status ?? 'info',
                    severity: item.severity ?? 'info',
                    details: item.details ?? null,
                    metadata: (item.metadata as object) ?? null,
                    ipAddress: item.ipAddress ?? null,
                    userAgent: item.userAgent ?? null,
                    sessionId: item.sessionId ?? null,
                    correlationId: item.correlationId ?? null,
                    executionId: item.executionId ?? null,
                    region: item.region ?? null,
                    accountId: item.accountId ?? null,
                    duration: item.duration ?? null,
                    errorCode: item.errorCode ?? null,
                    source: item.source ?? 'system',
                    expiresAt,
                };
            }),
            skipDuplicates: true, // ON CONFLICT DO NOTHING — idempotent re-runs
        });

        processedCount = Math.min(i + BATCH_SIZE, allItems.length);
        console.log(`Migrated ${processedCount}/${total} records...`);
    }

    console.log(`\nAudit log migration complete. Processed: ${processedCount} records.`);
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
