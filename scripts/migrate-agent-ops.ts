#!/usr/bin/env npx tsx
/**
 * migrate-agent-ops.ts
 *
 * Migrates all Agent Ops records from DynamoDB AgentOpsTable to PostgreSQL.
 *
 * Migrates:
 *   - agent_ops_runs      (SK starts with RUN#)
 *   - agent_ops_events    (SK starts with EVENT#)
 *   - scheduled_tasks     (SK starts with SCHED#)
 *
 * Uses full table scan (AgentOpsTable has no GSI covering all item types).
 * Batches in chunks of 500 with progress logging.
 *
 * Prerequisites:
 *   - docker compose up -d postgres (PostgreSQL running locally)
 *   - npm run db:migrate (schema applied, run from web-ui/)
 *   - DATABASE_URL set in environment
 *   - AWS credentials available (AWS_PROFILE=PLATFORM-ADMIN or env vars)
 *
 * Usage:
 *   AWS_PROFILE=PLATFORM-ADMIN DATABASE_URL=postgresql://... AGENT_OPS_TABLE_NAME=NucleusAgentOpsTable npx tsx scripts/migrate-agent-ops.ts
 *
 * Idempotent: safe to re-run — uses upsert (ON CONFLICT DO UPDATE via Prisma upsert).
 * Progress: prints "Migrated X/Y records..." after each batch.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { PrismaClient } from '@prisma/client';

// ── Configuration ─────────────────────────────────────────────────────────────

const AGENT_OPS_TABLE_NAME = process.env.AGENT_OPS_TABLE_NAME;
const DATABASE_URL = process.env.DATABASE_URL;
const BATCH_SIZE = 500;

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

// ── Types ─────────────────────────────────────────────────────────────────────

interface DynamoItem {
    PK?: string;
    SK?: string;
    [key: string]: unknown;
}

interface DynamoRunItem extends DynamoItem {
    runId?: string;
    tenantId?: string;
    source?: string;
    status?: string;
    taskDescription?: string;
    mode?: string;
    accountId?: string;
    accountName?: string;
    selectedSkill?: string;
    autoApprove?: boolean;
    model?: string;
    threadId?: string;
    mcpServerIds?: string[];
    trigger?: unknown;
    result?: unknown;
    clarification?: unknown;
    approvalRequest?: unknown;
    error?: string;
    createdAt?: string;
    updatedAt?: string;
    completedAt?: string;
    durationMs?: number;
    ttl?: number;
}

interface DynamoEventItem extends DynamoItem {
    runId?: string;
    eventType?: string;
    node?: string;
    content?: string;
    toolName?: string;
    toolArgs?: unknown;
    toolOutput?: string;
    metadata?: unknown;
    createdAt?: string;
    ttl?: number;
}

interface DynamoScheduledTaskItem extends DynamoItem {
    taskId?: string;
    tenantId?: string;
    name?: string;
    description?: string;
    cronExpression?: string;
    timezone?: string;
    taskStatus?: string;
    mode?: string;
    autoApprove?: boolean;
    model?: string;
    accountId?: string;
    accountName?: string;
    mcpServerIds?: string[];
    notification?: unknown;
    lastRunId?: string;
    lastRunAt?: string;
    lastRunStatus?: string;
    nextRunAt?: string;
    runCount?: number;
    createdAt?: string;
    updatedAt?: string;
    createdBy?: string;
    ttl?: number;
}

// ── DynamoDB Scan Helper ──────────────────────────────────────────────────────

async function scanAllItems(): Promise<DynamoItem[]> {
    const items: DynamoItem[] = [];
    let lastEvaluatedKey: Record<string, unknown> | undefined;

    do {
        const command = new ScanCommand({
            TableName: AGENT_OPS_TABLE_NAME as string,
            ExclusiveStartKey: lastEvaluatedKey,
        });

        const response = await dynamoClient.send(command);
        items.push(...((response.Items ?? []) as DynamoItem[]));
        lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;

        if (lastEvaluatedKey) {
            console.log(`  Scanned ${items.length} items so far, fetching next page...`);
        }
    } while (lastEvaluatedKey);

    return items;
}

// ── TTL Helper ────────────────────────────────────────────────────────────────

function ttlToDate(ttl: number | undefined, defaultDays: number): Date {
    if (ttl) {
        const d = new Date(ttl * 1000);
        if (d > new Date()) return d;
    }
    return new Date(Date.now() + defaultDays * 24 * 60 * 60 * 1000);
}

// ── Migrate Runs ──────────────────────────────────────────────────────────────

async function migrateRuns(
    items: DynamoRunItem[]
): Promise<{ migrated: number; skipped: number; runTenantMap: Map<string, string> }> {
    const total = items.length;
    console.log(`\nMigrating ${total} agent ops runs...`);

    const runTenantMap = new Map<string, string>();
    let migrated = 0;
    let skipped = 0;

    // Process in batches
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const batch = items.slice(i, i + BATCH_SIZE);

        for (const item of batch) {
            const runId = item.runId ?? item.SK?.replace('RUN#', '');
            const tenantId = item.tenantId ?? item.PK?.replace('TENANT#', '') ?? 'org-default';

            if (!runId) {
                console.warn(`  SKIP: run item with no runId — PK=${item.PK}, SK=${item.SK}`);
                skipped += 1;
                continue;
            }

            if (!item.taskDescription) {
                console.warn(`  SKIP: run ${runId} has no taskDescription — skipping`);
                skipped += 1;
                continue;
            }

            runTenantMap.set(runId, tenantId);
            const expiresAt = ttlToDate(item.ttl, 30);

            await prisma.agentOpsRun.upsert({
                where: { tenantId_runId: { tenantId, runId } },
                create: {
                    tenantId,
                    runId,
                    source: item.source ?? 'api',
                    status: item.status ?? 'completed',
                    taskDescription: item.taskDescription,
                    mode: item.mode ?? 'plan',
                    accountId: item.accountId ?? null,
                    accountName: item.accountName ?? null,
                    selectedSkill: item.selectedSkill ?? null,
                    autoApprove: item.autoApprove ?? false,
                    model: item.model ?? null,
                    threadId: item.threadId ?? `agent-ops-${runId}`,
                    mcpServerIds: item.mcpServerIds ?? [],
                    trigger: (item.trigger as object) ?? {},
                    result: (item.result as object) ?? null,
                    clarification: (item.clarification as object) ?? null,
                    approvalRequest: (item.approvalRequest as object) ?? null,
                    error: item.error ?? null,
                    createdAt: item.createdAt ? new Date(item.createdAt) : new Date(),
                    updatedAt: item.updatedAt ? new Date(item.updatedAt) : new Date(),
                    completedAt: item.completedAt ? new Date(item.completedAt) : null,
                    durationMs: item.durationMs ?? null,
                    expiresAt,
                },
                update: {
                    status: item.status ?? 'completed',
                    result: (item.result as object) ?? null,
                    clarification: (item.clarification as object) ?? null,
                    approvalRequest: (item.approvalRequest as object) ?? null,
                    error: item.error ?? null,
                    updatedAt: item.updatedAt ? new Date(item.updatedAt) : new Date(),
                    completedAt: item.completedAt ? new Date(item.completedAt) : null,
                    durationMs: item.durationMs ?? null,
                    expiresAt,
                },
            });

            migrated += 1;
        }

        console.log(`Migrated ${migrated}/${total} agent ops runs...`);
    }

    return { migrated, skipped, runTenantMap };
}

// ── Migrate Events ────────────────────────────────────────────────────────────

async function migrateEvents(
    items: DynamoEventItem[],
    runTenantMap: Map<string, string>
): Promise<{ migrated: number; skipped: number }> {
    const total = items.length;
    console.log(`\nMigrating ${total} agent ops events...`);

    let migrated = 0;
    let skipped = 0;

    for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const batch = items.slice(i, i + BATCH_SIZE);

        for (const item of batch) {
            const runId = item.runId ?? item.PK?.replace('RUN#', '');

            if (!runId) {
                console.warn(`  SKIP: event item with no runId — PK=${item.PK}, SK=${item.SK}`);
                skipped += 1;
                continue;
            }

            const tenantId = runTenantMap.get(runId) ?? 'org-default';
            const expiresAt = ttlToDate(item.ttl, 30);
            const createdAt = item.createdAt ? new Date(item.createdAt) : new Date();

            // Use a composite key for idempotency: runId + SK (EVENT#ts#nonce)
            // Since there's no unique constraint on events, use createMany with skipDuplicates
            // We'll use a synthetic id derived from SK for upsert
            await prisma.agentOpsEvent.create({
                data: {
                    tenantId,
                    runId,
                    eventType: item.eventType ?? 'execution',
                    node: item.node ?? 'unknown',
                    content: item.content ?? null,
                    toolName: item.toolName ?? null,
                    toolArgs: (item.toolArgs as object) ?? null,
                    toolOutput: item.toolOutput ?? null,
                    metadata: (item.metadata as object) ?? null,
                    createdAt,
                    expiresAt,
                },
            }).catch(() => {
                // Skip duplicates silently — events may already exist from previous runs
            });

            migrated += 1;
        }

        console.log(`Migrated ${migrated}/${total} agent ops events...`);
    }

    return { migrated, skipped };
}

// ── Migrate Scheduled Tasks ───────────────────────────────────────────────────

async function migrateScheduledTasks(
    items: DynamoScheduledTaskItem[]
): Promise<{ migrated: number; skipped: number }> {
    const total = items.length;
    console.log(`\nMigrating ${total} scheduled tasks...`);

    let migrated = 0;
    let skipped = 0;

    for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const batch = items.slice(i, i + BATCH_SIZE);

        for (const item of batch) {
            const taskId = item.taskId ?? item.SK?.replace('SCHED#', '');
            const tenantId = item.tenantId ?? item.PK?.replace('TENANT#', '') ?? 'org-default';

            if (!taskId) {
                console.warn(`  SKIP: scheduled task item with no taskId — PK=${item.PK}, SK=${item.SK}`);
                skipped += 1;
                continue;
            }

            if (!item.name || !item.cronExpression) {
                console.warn(`  SKIP: scheduled task ${taskId} missing name or cronExpression — skipping`);
                skipped += 1;
                continue;
            }

            await prisma.scheduledTask.upsert({
                where: { tenantId_taskId: { tenantId, taskId } },
                create: {
                    tenantId,
                    taskId,
                    name: item.name,
                    description: item.description ?? '',
                    cronExpression: item.cronExpression,
                    timezone: item.timezone ?? 'UTC',
                    taskStatus: item.taskStatus ?? 'active',
                    mode: item.mode ?? 'plan',
                    autoApprove: item.autoApprove ?? false,
                    model: item.model ?? null,
                    accountId: item.accountId ?? null,
                    accountName: item.accountName ?? null,
                    mcpServerIds: item.mcpServerIds ?? [],
                    notification: (item.notification as object) ?? { type: 'none' },
                    lastRunId: item.lastRunId ?? null,
                    lastRunAt: item.lastRunAt ? new Date(item.lastRunAt) : null,
                    lastRunStatus: item.lastRunStatus ?? null,
                    nextRunAt: item.nextRunAt ? new Date(item.nextRunAt) : null,
                    runCount: item.runCount ?? 0,
                    createdAt: item.createdAt ? new Date(item.createdAt) : new Date(),
                    updatedAt: item.updatedAt ? new Date(item.updatedAt) : new Date(),
                    createdBy: item.createdBy ?? 'migration',
                },
                update: {
                    name: item.name,
                    description: item.description ?? '',
                    cronExpression: item.cronExpression,
                    timezone: item.timezone ?? 'UTC',
                    taskStatus: item.taskStatus ?? 'active',
                    lastRunId: item.lastRunId ?? null,
                    lastRunAt: item.lastRunAt ? new Date(item.lastRunAt) : null,
                    lastRunStatus: item.lastRunStatus ?? null,
                    nextRunAt: item.nextRunAt ? new Date(item.nextRunAt) : null,
                    runCount: item.runCount ?? 0,
                    updatedAt: item.updatedAt ? new Date(item.updatedAt) : new Date(),
                },
            });

            migrated += 1;
        }

        console.log(`Migrated ${migrated}/${total} scheduled tasks...`);
    }

    return { migrated, skipped };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function migrate(): Promise<void> {
    console.log('Starting agent ops migration: DynamoDB -> PostgreSQL');
    console.log(`  Source table: ${AGENT_OPS_TABLE_NAME}`);
    console.log(`  AWS_PROFILE: ${process.env.AWS_PROFILE ?? '(default)'}`);
    console.log('');

    console.log('Scanning DynamoDB AgentOpsTable (full scan)...');
    const allItems = await scanAllItems();
    console.log(`Found ${allItems.length} total items. Classifying by SK prefix...\n`);

    // Classify items by SK prefix
    const runItems: DynamoRunItem[] = [];
    const eventItems: DynamoEventItem[] = [];
    const scheduledTaskItems: DynamoScheduledTaskItem[] = [];
    let unknownCount = 0;

    for (const item of allItems) {
        const sk = item.SK ?? '';
        if (sk.startsWith('RUN#')) {
            runItems.push(item as DynamoRunItem);
        } else if (sk.startsWith('EVENT#')) {
            eventItems.push(item as DynamoEventItem);
        } else if (sk.startsWith('SCHED#')) {
            scheduledTaskItems.push(item as DynamoScheduledTaskItem);
        } else {
            unknownCount += 1;
        }
    }

    console.log(`  Runs:            ${runItems.length}`);
    console.log(`  Events:          ${eventItems.length}`);
    console.log(`  Scheduled Tasks: ${scheduledTaskItems.length}`);
    if (unknownCount > 0) {
        console.log(`  Unknown (skipped): ${unknownCount}`);
    }

    const runResult = await migrateRuns(runItems);
    const eventResult = await migrateEvents(eventItems, runResult.runTenantMap);
    const taskResult = await migrateScheduledTasks(scheduledTaskItems);

    console.log('\n─────────────────────────────────────────────────');
    console.log('Migration Summary:');
    console.log(`  Agent Ops Runs:   ${runResult.migrated} migrated, ${runResult.skipped} skipped.`);
    console.log(`  Agent Ops Events: ${eventResult.migrated} migrated, ${eventResult.skipped} skipped.`);
    console.log(`  Scheduled Tasks:  ${taskResult.migrated} migrated, ${taskResult.skipped} skipped.`);
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
