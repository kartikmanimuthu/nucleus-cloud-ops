#!/usr/bin/env npx tsx
/**
 * cleanup-expired.ts
 *
 * TTL replacement for PostgreSQL — DynamoDB had automatic TTL expiry via expire_at attribute.
 * PostgreSQL does not have built-in row expiry. This script deletes expired records.
 *
 * Tables cleaned:
 *   - audit_logs:            expiresAt < NOW() (30-day retention)
 *   - schedule_executions:   expiresAt < NOW() (90-day retention)
 *   - agent_memories:        expiresAt < NOW() (90-day retention)
 *   - agent_working_memory:  expiresAt < NOW() (per-thread scratchpad TTL)
 *   - spot_guard_events:     expiresAt < NOW() (90-day retention)
 *   - spot_guard_task_sessions: expiresAt < NOW() (closed: stoppedAt+90d; OPEN: startedAt+14d,
 *                            which is the orphan reaper for a lost ECS STOPPED event)
 *   - spot_guard_alert_dedup: expiresAt < NOW() (space reclaim ONLY — dedup correctness lives
 *                            in the conditional-reclaim upsert's WHERE/CASE predicate, not here,
 *                            so a late run can never silently widen an alert window)
 *   - spot_guard_actions:    expiresAt < NOW() (space reclaim only; the minute-window unique
 *                            key is what enforces exactly-once, not the row's presence)
 *
 * Tables INTENTIONALLY ABSENT from this script (do not add them):
 *   - scaling_events, scaling_audit_runs, scaling_audit_coverage,
 *     scaling_audit_watermarks, scaling_policy_snapshots, scaling_audit_daily_seals:
 *     SEBI compliance audit records (SA-001) — retention is indefinite by design,
 *     not merely "no TTL set yet". None of these tables has an expiresAt column;
 *     scaling_events and scaling_audit_daily_seals additionally reject UPDATE/DELETE
 *     at the database level (see the trigger in
 *     libs/prisma/migrations/20260805120000_add_scaling_audit/migration.sql).
 *
 * Run manually or on a schedule (EventBridge + Lambda or pg_cron in production).
 * Idempotent: safe to run multiple times — rows already deleted won't re-appear.
 *
 * Usage:
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/nucleus npx tsx scripts/cleanup-expired.ts
 *
 * Dry run (no deletes, counts only):
 *   DRY_RUN=true DATABASE_URL=postgresql://... npx tsx scripts/cleanup-expired.ts
 */

import { PrismaClient } from '@prisma/client';

// ── Configuration ─────────────────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL;
const DRY_RUN = process.env.DRY_RUN === 'true';

if (!DATABASE_URL) {
    console.error('ERROR: DATABASE_URL environment variable is required');
    process.exit(1);
}

// ── Client ────────────────────────────────────────────────────────────────────

const prisma = new PrismaClient({
    datasources: { db: { url: DATABASE_URL } },
    log: ['error'],
});

// ── Cleanup Logic ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const now = new Date();
    console.log(`cleanup-expired: starting at ${now.toISOString()} (dry_run=${DRY_RUN})`);
    console.log('');

    // ── Step 1: Count expired audit_logs ──────────────────────────────────────
    const expiredAuditCount = await prisma.auditLog.count({
        where: { expiresAt: { lt: now } },
    });
    console.log(`cleanup-expired: audit_logs with expiresAt < NOW(): ${expiredAuditCount}`);

    // ── Step 2: Count expired schedule_executions ─────────────────────────────
    const expiredExecCount = await prisma.scheduleExecution.count({
        where: { expiresAt: { lt: now } },
    });
    console.log(`cleanup-expired: schedule_executions with expiresAt < NOW(): ${expiredExecCount}`);

    // ── Step 2b: Count expired agent memories (long-term + per-thread working memory) ──
    const expiredMemoryCount = await prisma.agentMemory.count({
        where: { expiresAt: { lt: now } },
    });
    console.log(`cleanup-expired: agent_memories with expiresAt < NOW(): ${expiredMemoryCount}`);

    const expiredWorkingMemoryCount = await prisma.agentWorkingMemory.count({
        where: { expiresAt: { lt: now } },
    });
    console.log(`cleanup-expired: agent_working_memory with expiresAt < NOW(): ${expiredWorkingMemoryCount}`);

    // ── Step 2c: Count expired Fargate Spot Guard rows ────────────────────────
    const expiredSpotEventCount = await prisma.spotGuardEvent.count({
        where: { expiresAt: { lt: now } },
    });
    console.log(`cleanup-expired: spot_guard_events with expiresAt < NOW(): ${expiredSpotEventCount}`);

    const expiredSpotSessionCount = await prisma.spotGuardTaskSession.count({
        where: { expiresAt: { lt: now } },
    });
    console.log(`cleanup-expired: spot_guard_task_sessions with expiresAt < NOW(): ${expiredSpotSessionCount}`);

    const expiredSpotDedupCount = await prisma.spotGuardAlertDedup.count({
        where: { expiresAt: { lt: now } },
    });
    console.log(`cleanup-expired: spot_guard_alert_dedup with expiresAt < NOW(): ${expiredSpotDedupCount}`);

    const expiredSpotActionCount = await prisma.spotGuardAction.count({
        where: { expiresAt: { lt: now } },
    });
    console.log(`cleanup-expired: spot_guard_actions with expiresAt < NOW(): ${expiredSpotActionCount}`);
    console.log('');

    if (DRY_RUN) {
        console.log('cleanup-expired: DRY_RUN=true — no rows deleted.');
        console.log(`  Would delete: ${expiredAuditCount} audit_logs, ${expiredExecCount} schedule_executions, ${expiredMemoryCount} agent_memories, ${expiredWorkingMemoryCount} agent_working_memory, ${expiredSpotEventCount} spot_guard_events, ${expiredSpotSessionCount} spot_guard_task_sessions, ${expiredSpotDedupCount} spot_guard_alert_dedup, ${expiredSpotActionCount} spot_guard_actions`);
        return;
    }

    // ── Step 3: Delete expired audit_logs ─────────────────────────────────────
    const deletedAudit = await prisma.auditLog.deleteMany({
        where: { expiresAt: { lt: now } },
    });
    console.log(`cleanup-expired: deleted ${deletedAudit.count} expired audit_logs`);

    // ── Step 4: Delete expired schedule_executions ────────────────────────────
    const deletedExec = await prisma.scheduleExecution.deleteMany({
        where: { expiresAt: { lt: now } },
    });
    console.log(`cleanup-expired: deleted ${deletedExec.count} expired schedule_executions`);

    // ── Step 5: Delete expired agent memories ─────────────────────────────────
    const deletedMemory = await prisma.agentMemory.deleteMany({
        where: { expiresAt: { lt: now } },
    });
    console.log(`cleanup-expired: deleted ${deletedMemory.count} expired agent_memories`);

    // ── Step 6: Delete expired agent working memory ───────────────────────────
    const deletedWorkingMemory = await prisma.agentWorkingMemory.deleteMany({
        where: { expiresAt: { lt: now } },
    });
    console.log(`cleanup-expired: deleted ${deletedWorkingMemory.count} expired agent_working_memory`);

    // ── Step 7: Delete expired Fargate Spot Guard rows ────────────────────────
    const deletedSpotEvents = await prisma.spotGuardEvent.deleteMany({
        where: { expiresAt: { lt: now } },
    });
    console.log(`cleanup-expired: deleted ${deletedSpotEvents.count} expired spot_guard_events`);

    const deletedSpotSessions = await prisma.spotGuardTaskSession.deleteMany({
        where: { expiresAt: { lt: now } },
    });
    console.log(`cleanup-expired: deleted ${deletedSpotSessions.count} expired spot_guard_task_sessions`);

    const deletedSpotDedup = await prisma.spotGuardAlertDedup.deleteMany({
        where: { expiresAt: { lt: now } },
    });
    console.log(`cleanup-expired: deleted ${deletedSpotDedup.count} expired spot_guard_alert_dedup`);

    const deletedSpotActions = await prisma.spotGuardAction.deleteMany({
        where: { expiresAt: { lt: now } },
    });
    console.log(`cleanup-expired: deleted ${deletedSpotActions.count} expired spot_guard_actions`);

    console.log('');
    console.log(
        `cleanup-expired: complete. audit_logs deleted: ${deletedAudit.count}, schedule_executions deleted: ${deletedExec.count}, agent_memories deleted: ${deletedMemory.count}, agent_working_memory deleted: ${deletedWorkingMemory.count}, spot_guard_events deleted: ${deletedSpotEvents.count}, spot_guard_task_sessions deleted: ${deletedSpotSessions.count}, spot_guard_alert_dedup deleted: ${deletedSpotDedup.count}, spot_guard_actions deleted: ${deletedSpotActions.count}`
    );
}

// ── Entry Point ───────────────────────────────────────────────────────────────

main()
    .catch((error: unknown) => {
        console.error('cleanup-expired failed:', error);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
