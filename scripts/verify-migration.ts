#!/usr/bin/env npx tsx
/**
 * verify-migration.ts
 *
 * Compares DynamoDB vs PostgreSQL row counts per entity to verify migration completeness.
 * Exits with code 1 if any count mismatch is detected (CI-ready).
 *
 * Usage:
 *   AWS_PROFILE=PLATFORM-ADMIN DATABASE_URL=postgresql://... npx tsx scripts/verify-migration.ts
 *
 * Notes:
 *   - AgentConversationsTable: confirmed dead code, CDK definition removed (per D-23)
 *   - Chat History + Memory: fresh start on PostgreSQL — no migration (per D-08/D-09)
 *   - DynamoDB counts use ScanCommand with Select: 'COUNT' for accuracy (DescribeTable is approximate)
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { PrismaClient, Prisma } from '@prisma/client';

// ── Configuration ─────────────────────────────────────────────────────────────

const APP_TABLE_NAME = process.env.APP_TABLE_NAME ?? process.env.DYNAMODB_TABLE_NAME;
const AUDIT_TABLE_NAME = process.env.AUDIT_TABLE_NAME ?? process.env.DYNAMODB_AUDIT_TABLE_NAME;
const AGENT_OPS_TABLE_NAME = process.env.AGENT_OPS_TABLE_NAME;
const DATABASE_URL = process.env.DATABASE_URL;

if (!APP_TABLE_NAME) {
    console.error('ERROR: APP_TABLE_NAME (or DYNAMODB_TABLE_NAME) environment variable is required');
    process.exit(1);
}

if (!AUDIT_TABLE_NAME) {
    console.error('ERROR: AUDIT_TABLE_NAME (or DYNAMODB_AUDIT_TABLE_NAME) environment variable is required');
    process.exit(1);
}

if (!AGENT_OPS_TABLE_NAME) {
    console.error('ERROR: AGENT_OPS_TABLE_NAME environment variable is required');
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

// ── DynamoDB Count Helpers ────────────────────────────────────────────────────

/** Full table scan count — used for dedicated tables (AUDIT, AGENT_OPS) */
async function countDynamoTable(tableName: string): Promise<number> {
    let count = 0;
    let lastEvaluatedKey: Record<string, unknown> | undefined;

    do {
        const command = new ScanCommand({
            TableName: tableName,
            Select: 'COUNT',
            ExclusiveStartKey: lastEvaluatedKey,
        });
        const response = await dynamoClient.send(command);
        count += response.Count ?? 0;
        lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastEvaluatedKey);

    return count;
}

/** GSI1 query count — used for entity types stored in APP_TABLE */
async function countDynamoGSI1(tableName: string, gsi1pk: string): Promise<number> {
    let count = 0;
    let lastEvaluatedKey: Record<string, unknown> | undefined;

    do {
        const command = new QueryCommand({
            TableName: tableName,
            IndexName: 'GSI1',
            KeyConditionExpression: 'gsi1pk = :gsi1pk',
            ExpressionAttributeValues: { ':gsi1pk': gsi1pk },
            Select: 'COUNT',
            ExclusiveStartKey: lastEvaluatedKey,
        });
        const response = await dynamoClient.send(command);
        count += response.Count ?? 0;
        lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastEvaluatedKey);

    return count;
}

/** Scan with SK prefix filter — used for KB and DataSource entities */
async function countDynamoSkPrefix(tableName: string, skPrefix: string): Promise<number> {
    let count = 0;
    let lastEvaluatedKey: Record<string, unknown> | undefined;

    do {
        const command = new ScanCommand({
            TableName: tableName,
            FilterExpression: 'begins_with(sk, :skPrefix)',
            ExpressionAttributeValues: { ':skPrefix': skPrefix },
            Select: 'COUNT',
            ExclusiveStartKey: lastEvaluatedKey,
        });
        const response = await dynamoClient.send(command);
        count += response.Count ?? 0;
        lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastEvaluatedKey);

    return count;
}

/** Scan with SK filter — used for Agent Ops Runs (sk = 'METADATA') */
async function countDynamoSkEquals(tableName: string, skValue: string): Promise<number> {
    let count = 0;
    let lastEvaluatedKey: Record<string, unknown> | undefined;

    do {
        const command = new ScanCommand({
            TableName: tableName,
            FilterExpression: 'sk = :sk',
            ExpressionAttributeValues: { ':sk': skValue },
            Select: 'COUNT',
            ExclusiveStartKey: lastEvaluatedKey,
        });
        const response = await dynamoClient.send(command);
        count += response.Count ?? 0;
        lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastEvaluatedKey);

    return count;
}

// ── PostgreSQL Count Helper ───────────────────────────────────────────────────

async function countPgTable(tableName: string): Promise<number> {
    const result = await prisma.$queryRaw<[{ count: bigint }]>(
        Prisma.sql`SELECT COUNT(*) as count FROM ${Prisma.raw(`"${tableName}"`)}`
    );
    return Number(result[0].count);
}

// ── Table Definitions ─────────────────────────────────────────────────────────

interface TableEntry {
    name: string;
    pgTable: string;
    getDynamoCount: () => Promise<number>;
}

function buildTableEntries(): TableEntry[] {
    return [
        {
            name: 'Tenants',
            pgTable: 'tenants',
            getDynamoCount: () => countDynamoGSI1(APP_TABLE_NAME!, 'TYPE#TENANT'),
        },
        {
            name: 'Tenant Configs',
            pgTable: 'tenant_configs',
            getDynamoCount: () => countDynamoSkPrefix(APP_TABLE_NAME!, 'CONFIG#'),
        },
        {
            name: 'Accounts',
            pgTable: 'accounts',
            getDynamoCount: () => countDynamoGSI1(APP_TABLE_NAME!, 'TYPE#ACCOUNT'),
        },
        {
            name: 'User Tenant Roles',
            pgTable: 'user_tenant_roles',
            // RBAC table has no GSI — full scan
            getDynamoCount: () => countDynamoTable(process.env.RBAC_TABLE_NAME ?? APP_TABLE_NAME!),
        },
        {
            name: 'Schedules',
            pgTable: 'schedules',
            getDynamoCount: () => countDynamoGSI1(APP_TABLE_NAME!, 'TYPE#SCHEDULE'),
        },
        {
            name: 'Schedule Executions',
            pgTable: 'schedule_executions',
            getDynamoCount: () => countDynamoGSI1(APP_TABLE_NAME!, 'TYPE#EXECUTION'),
        },
        {
            name: 'Audit Logs',
            pgTable: 'audit_logs',
            getDynamoCount: () => countDynamoTable(AUDIT_TABLE_NAME!),
        },
        {
            name: 'Knowledge Bases',
            pgTable: 'knowledge_bases',
            getDynamoCount: () => countDynamoSkPrefix(APP_TABLE_NAME!, 'KB#'),
        },
        {
            name: 'Data Sources',
            pgTable: 'data_sources',
            getDynamoCount: () => countDynamoSkPrefix(APP_TABLE_NAME!, 'DS#'),
        },
        {
            name: 'Inventory Resources',
            pgTable: 'inventory_resources',
            getDynamoCount: () =>
                countDynamoTable(process.env.INVENTORY_TABLE_NAME ?? APP_TABLE_NAME!),
        },
        {
            name: 'Agent Ops Runs',
            pgTable: 'agent_ops_runs',
            getDynamoCount: () => countDynamoSkEquals(AGENT_OPS_TABLE_NAME!, 'METADATA'),
        },
        {
            name: 'Agent Ops Events',
            pgTable: 'agent_ops_events',
            getDynamoCount: () => countDynamoSkPrefix(AGENT_OPS_TABLE_NAME!, 'EVENT#'),
        },
        {
            name: 'Scheduled Tasks',
            pgTable: 'scheduled_tasks',
            getDynamoCount: () => countDynamoSkPrefix(AGENT_OPS_TABLE_NAME!, 'SCHED#'),
        },
    ];
}

// ── Table Formatting ──────────────────────────────────────────────────────────

function padEnd(str: string, len: number): string {
    return str.length >= len ? str : str + ' '.repeat(len - str.length);
}

function padStart(str: string, len: number): string {
    return str.length >= len ? str : ' '.repeat(len - str.length) + str;
}

// ── Main ───────────────────────────────────────────────────────────────────────

interface RowResult {
    name: string;
    pgTable: string;
    dynamoCount: number | null;
    pgCount: number | null;
    error: string | null;
}

async function verify(): Promise<void> {
    console.log('='.repeat(70));
    console.log('Nucleus Cloud Ops — Migration Verification (DynamoDB vs PostgreSQL)');
    console.log('='.repeat(70));
    console.log(`AWS_PROFILE: ${process.env.AWS_PROFILE ?? '(default)'}`);
    console.log(`APP_TABLE:   ${APP_TABLE_NAME}`);
    console.log(`AUDIT_TABLE: ${AUDIT_TABLE_NAME}`);
    console.log(`AGENT_OPS:   ${AGENT_OPS_TABLE_NAME}`);
    console.log('');
    console.log('Counting rows... (this may take a moment for large tables)');
    console.log('');

    const entries = buildTableEntries();
    const results: RowResult[] = [];

    for (const entry of entries) {
        process.stdout.write(`  Checking ${entry.name}...`);
        let dynamoCount: number | null = null;
        let pgCount: number | null = null;
        let error: string | null = null;

        try {
            [dynamoCount, pgCount] = await Promise.all([
                entry.getDynamoCount(),
                countPgTable(entry.pgTable),
            ]);
            process.stdout.write(` DynamoDB=${dynamoCount}, PostgreSQL=${pgCount}\n`);
        } catch (err: unknown) {
            error = err instanceof Error ? err.message : String(err);
            process.stdout.write(` ERROR: ${error}\n`);
        }

        results.push({ name: entry.name, pgTable: entry.pgTable, dynamoCount, pgCount, error });
    }

    // ── Render Table ─────────────────────────────────────────────────────────

    const COL_NAME = 24;
    const COL_DYNAMO = 10;
    const COL_PG = 12;
    const COL_MATCH = 7;
    const COL_DELTA = 7;

    const hr = `├${'─'.repeat(COL_NAME + 2)}┼${'─'.repeat(COL_DYNAMO + 2)}┼${'─'.repeat(COL_PG + 2)}┼${'─'.repeat(COL_MATCH + 2)}┼${'─'.repeat(COL_DELTA + 2)}┤`;
    const top = `┌${'─'.repeat(COL_NAME + 2)}┬${'─'.repeat(COL_DYNAMO + 2)}┬${'─'.repeat(COL_PG + 2)}┬${'─'.repeat(COL_MATCH + 2)}┬${'─'.repeat(COL_DELTA + 2)}┐`;
    const bot = `└${'─'.repeat(COL_NAME + 2)}┴${'─'.repeat(COL_DYNAMO + 2)}┴${'─'.repeat(COL_PG + 2)}┴${'─'.repeat(COL_MATCH + 2)}┴${'─'.repeat(COL_DELTA + 2)}┘`;

    console.log('');
    console.log(top);
    console.log(
        `│ ${padEnd('Table', COL_NAME)} │ ${padEnd('DynamoDB', COL_DYNAMO)} │ ${padEnd('PostgreSQL', COL_PG)} │ ${padEnd('Match', COL_MATCH)} │ ${padEnd('Delta', COL_DELTA)} │`
    );
    console.log(hr);

    let mismatches = 0;
    let errors = 0;

    for (const row of results) {
        if (row.error) {
            errors += 1;
            console.log(
                `│ ${padEnd(row.name, COL_NAME)} │ ${padStart('ERROR', COL_DYNAMO)} │ ${padStart('ERROR', COL_PG)} │ ${padEnd('ERROR', COL_MATCH)} │ ${padStart('-', COL_DELTA)} │`
            );
            continue;
        }

        const d = row.dynamoCount ?? 0;
        const p = row.pgCount ?? 0;
        const delta = p - d;
        const match = delta === 0 ? 'YES' : 'NO';
        if (delta !== 0) mismatches += 1;

        console.log(
            `│ ${padEnd(row.name, COL_NAME)} │ ${padStart(String(d), COL_DYNAMO)} │ ${padStart(String(p), COL_PG)} │ ${padEnd(match, COL_MATCH)} │ ${padStart(String(delta), COL_DELTA)} │`
        );
    }

    console.log(bot);

    // ── Notes ─────────────────────────────────────────────────────────────────

    console.log('');
    console.log('Notes:');
    console.log('  AgentConversationsTable: confirmed dead code, CDK definition removed (per D-23)');
    console.log('  Chat History + Memory: fresh start on PostgreSQL (no migration — per D-08/D-09)');
    console.log('');

    // ── Summary ───────────────────────────────────────────────────────────────

    if (errors > 0) {
        console.error(`ERRORS: ${errors} table(s) could not be counted. Check connectivity and env vars.`);
    }

    if (mismatches > 0) {
        console.error(`MISMATCH: ${mismatches} table(s) have different row counts between DynamoDB and PostgreSQL.`);
        console.error('Re-run the relevant migration script(s) to reconcile, then verify again.');
        process.exit(1);
    }

    if (errors > 0) {
        process.exit(1);
    }

    console.log(`All ${results.length} tables verified — counts match. Migration complete.`);
}

// ── Entry Point ───────────────────────────────────────────────────────────────

verify()
    .catch((error: unknown) => {
        console.error('Verification failed:', error);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
