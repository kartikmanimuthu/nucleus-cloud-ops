import type PgBoss from 'pg-boss';
import { Cron } from 'croner';
import { createLogger } from '../../lib/logger.js';
import type { JobExecutor } from '../../executor/index.js';
import { DEAD_LETTER_QUEUE } from '../../lib/tenant-fanout.js';
import { Pool, type PoolClient } from 'pg';
import { env } from '../../env.js';

export interface ActiveTaskRow {
    taskId: string;
    tenantId: string;
    scheduleType: string;          // 'cron' | 'interval'
    cronExpression: string;        // empty string for interval tasks
    intervalMinutes: number | null; // set for interval tasks
    timezone: string;
    nextRunAt: Date | null;        // fire anchor for interval tasks
}

const log = createLogger('agent-ops-scheduler');

// Single shared tick queue for ALL tenant scheduled tasks. The previous design
// created one pg-boss queue + one work() poller PER active task (pgboss.schedule
// is keyed by queue name, so per-task cron forces per-task queues). At N tasks
// that was N pollers each doing an indexed SELECT every pollingIntervalSeconds
// (1s) — O(N) DB round-trips/second doing nothing — plus a consumer/queue leak on
// task deletion. This sweeper evaluates cron in-app and multiplexes every task
// onto ONE queue: one poller, unlimited tasks, no per-task leak.
const TICK_QUEUE = 'agent-ops-tick';

// How often the sweeper evaluates which tasks are due.
const SWEEP_INTERVAL_MS = 30_000;
// A task counts as "due" if its most recent scheduled occurrence is within this
// window (mirrors pg-boss's own timekeeper `prevDiff < 60`). singletonSeconds:60
// on the send collapses the two sweeps that fall inside one due-minute into a
// single tick, and works across replicas.
const DUE_WINDOW_MS = 60_000;

const INTERNAL_API_KEY = env.INTERNAL_API_KEY;
const WEB_UI_BASE_URL = env.WEB_UI_BASE_URL || `http://localhost:${env.PORT || 3000}`;

let _pool: Pool | null = null;
function getPool(): Pool {
    if (!_pool) {
        _pool = new Pool({ connectionString: env.DATABASE_URL, max: 2 });
    }
    return _pool;
}

async function writeAuditLog(entry: {
    tenantId: string;
    eventType: string;
    action: string;
    resourceId: string;
    status: string;
    severity: string;
    details: string;
    metadata?: Record<string, unknown>;
}): Promise<void> {
    const client: PoolClient = await getPool().connect();
    try {
        const id = `log-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const logId = `log-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        await client.query(
            `INSERT INTO audit_logs
               (id, "tenantId", "logId", timestamp, "eventType", action,
                "user", "userType", "resourceType", "resourceId",
                status, severity, details, metadata, "expiresAt", source)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
             ON CONFLICT DO NOTHING`,
            [
                id, entry.tenantId, logId, new Date().toISOString(),
                entry.eventType, entry.action,
                'system', 'system',
                'agent', entry.resourceId,
                entry.status, entry.severity, entry.details,
                entry.metadata ? JSON.stringify(entry.metadata) : null,
                expiresAt.toISOString(), 'system',
            ],
        );
    } catch (error) {
        log.error('Error writing audit log', { error: error instanceof Error ? error.message : String(error) });
    } finally {
        client.release();
    }
}

export interface TaskTickData {
    taskId: string;
    tenantId: string;
}

/**
 * The trigger endpoint's marker for "the creator's grant no longer covers this
 * run". Kept in sync with PERMISSION_REVOKED in
 * apps/web-ui/lib/agent-ops/scheduled-task-permission.ts, which is also the
 * taskStatus value the CHECK constraint in 20260731000000_agent_ops_creator_grant
 * allows.
 */
export const PERMISSION_REVOKED = 'permission_revoked';

let _prisma: import('@prisma/client').PrismaClient | null = null;
async function getPrisma(): Promise<import('@prisma/client').PrismaClient> {
    if (!_prisma) {
        const { PrismaClient } = await import('@prisma/client');
        _prisma = new PrismaClient();
    }
    return _prisma;
}

async function loadActiveTasks(): Promise<ActiveTaskRow[]> {
    const prisma = await getPrisma();
    return prisma.scheduledTask.findMany({
        where: { taskStatus: 'active' },
        select: {
            taskId: true,
            tenantId: true,
            scheduleType: true,
            cronExpression: true,
            intervalMinutes: true,
            timezone: true,
            nextRunAt: true,
        },
    });
}

/**
 * Pure selection of which active tasks are due at `nowMs`.
 *
 * Cron tasks: due if the most recent scheduled occurrence (per cron + timezone)
 * falls within `windowMs` before now. A malformed cron is skipped (never throws).
 *
 * Interval tasks: due when their `nextRunAt` anchor has passed. The sweep
 * advances the anchor by `intervalMinutes` immediately after enqueueing (see
 * advanceIntervalAnchor) so subsequent sweeps don't re-fire while the run is
 * still executing; run finalization re-anchors it again to run-end + interval.
 * A null anchor (legacy row / just switched to interval) fires once and is then
 * advanced normally.
 */
export function selectDueTasks(tasks: ActiveTaskRow[], nowMs: number, windowMs: number): ActiveTaskRow[] {
    const ref = new Date(nowMs);
    return tasks.filter((t) => {
        if (t.scheduleType === 'interval') {
            if (!t.intervalMinutes || t.intervalMinutes <= 0) {
                log.warn('Interval task without intervalMinutes — skipping', { taskId: t.taskId });
                return false;
            }
            return t.nextRunAt === null || t.nextRunAt.getTime() <= nowMs;
        }
        try {
            const cron = new Cron(t.cronExpression, { timezone: t.timezone });
            const prev = cron.previousRuns(1, ref)[0];
            return !!prev && nowMs - prev.getTime() < windowMs;
        } catch (err) {
            log.warn('Invalid cron expression — skipping task', {
                taskId: t.taskId,
                cronExpression: t.cronExpression,
                error: err instanceof Error ? err.message : String(err),
            });
            return false;
        }
    });
}

/**
 * Push an interval task's nextRunAt forward so the next sweep doesn't re-fire
 * it while its run is still executing. Concurrent sweeps racing here are
 * harmless: the enqueue is de-duped by singletonKey, and both racers write
 * approximately the same anchor.
 */
async function advanceIntervalAnchor(task: ActiveTaskRow, nowMs: number): Promise<void> {
    if (task.scheduleType !== 'interval' || !task.intervalMinutes) return;
    const prisma = await getPrisma();
    await prisma.scheduledTask.updateMany({
        where: { tenantId: task.tenantId, taskId: task.taskId },
        data: { nextRunAt: new Date(nowMs + task.intervalMinutes * 60_000) },
    });
}

/**
 * Takes a task out of the firing set because the person it runs on behalf of may
 * no longer authorize it.
 *
 * This is the enforcement, not a label: `loadActiveTasks()` selects
 * taskStatus = 'active', so moving the row here is what actually stops the task.
 * It is deliberately NOT 'paused' — a human chose 'paused', and an operator must
 * be able to tell "someone turned this off" from "this lost its authority", which
 * is also why re-activating it has to go through the UI (and therefore through a
 * fresh authorization) rather than through a resume button.
 */
async function markPermissionRevoked(tenantId: string, taskId: string, reason: string): Promise<void> {
    try {
        const prisma = await getPrisma();
        await prisma.scheduledTask.updateMany({
            where: { tenantId, taskId },
            data: { taskStatus: PERMISSION_REVOKED },
        });
    } catch (error) {
        // Even if the write fails the tick still ends terminally (no retry), so the
        // task cannot execute. It will simply be re-evaluated on the next sweep and
        // denied again — noisy, but never permissive.
        log.error('Failed to mark task permission_revoked', {
            taskId,
            tenantId,
            error: error instanceof Error ? error.message : String(error),
        });
    }

    await writeAuditLog({
        tenantId,
        eventType: 'agent.task.permission_revoked',
        action: 'Scheduled Task Permission Revoked',
        resourceId: taskId,
        status: 'error',
        severity: 'high',
        details: `Scheduled task ${taskId} disabled — creator's permission was revoked: ${reason}`,
        metadata: { taskId, tenantId, reason, taskStatus: PERMISSION_REVOKED },
    });
}

/** Reads the `code` field out of a trigger error body without throwing on non-JSON. */
export function parseTriggerFailure(body: string): { code?: string; error?: string } {
    try {
        const parsed = JSON.parse(body) as { code?: string; error?: string };
        return { code: parsed?.code, error: parsed?.error };
    } catch {
        return {};
    }
}

export async function handleAgentOpsTick(jobData: unknown): Promise<void> {
    const { taskId, tenantId } = jobData as TaskTickData;
    log.info(`Tick: task=${taskId} tenant=${tenantId}`);

    if (!INTERNAL_API_KEY) {
        // Fail closed: without a shared secret we cannot authenticate to the web-ui
        // internal trigger endpoint. Throw so pg-boss retries (and the misconfig is
        // loud) rather than silently dropping the scheduled run.
        throw new Error('INTERNAL_API_KEY is not configured — cannot trigger scheduled task');
    }

    await writeAuditLog({
        tenantId,
        eventType: 'agent.task.cron_triggered',
        action: 'Cron Triggered Task',
        resourceId: taskId,
        status: 'info',
        severity: 'info',
        details: `Agent ops scheduler triggered task ${taskId}`,
        metadata: { taskId, tenantId },
    });

    const url = `${WEB_UI_BASE_URL}/api/agent-ops/scheduled-tasks/${taskId}/trigger`;
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-internal-key': INTERNAL_API_KEY,
            'x-tenant-id': tenantId,
        },
        body: JSON.stringify({ source: 'worker' }),
    });

    if (!res.ok) {
        const body = await res.text();
        log.error(`Trigger failed for task ${taskId}: ${res.status} ${body}`);

        // ── Stored-grant revocation ──────────────────────────────────────────
        // The web-ui recompiled the CREATOR's ability at execution time and found
        // it no longer covers an agent run. Handled BEFORE the generic failure
        // path because 403 is otherwise classified as retryable (an
        // INTERNAL_API_KEY misconfiguration must be loud), and retrying a
        // revocation would re-deny 3 times per tick, forever. A revoked grant is
        // terminal by definition: no amount of retrying restores a permission.
        const failure = parseTriggerFailure(body);
        if (res.status === 403 && failure.code === PERMISSION_REVOKED) {
            log.warn(`Task ${taskId} disabled — creator permission revoked`, { tenantId });
            await markPermissionRevoked(tenantId, taskId, failure.error || 'creator permission revoked');
            return;
        }

        await writeAuditLog({
            tenantId,
            eventType: 'agent.task.cron_failed',
            action: 'Cron Trigger Failed',
            resourceId: taskId,
            status: 'error',
            severity: 'high',
            details: `Agent ops scheduler trigger failed for task ${taskId}: ${res.status}`,
            metadata: { taskId, tenantId, statusCode: res.status },
        });
        // Retry 5xx, 429, 408 (transient), AND 401/403 — an auth failure is almost
        // always an INTERNAL_API_KEY misconfig, which must be LOUD (retry → exhaust →
        // dead-letter), never a silent green tick that drops every tenant's scheduled
        // run. Only task-STATE 4xx (404 not-found / 409 duplicate / 410 paused-or-
        // deleted) that the web-ui returns deliberately are terminal.
        const retryable =
            res.status >= 500 || res.status === 429 || res.status === 408
            || res.status === 401 || res.status === 403;
        if (!retryable) {
            log.warn(`Task ${taskId} trigger returned ${res.status} — terminal task state (no retry)`);
            return;
        }
        throw new Error(`Trigger failed for task ${taskId}: ${res.status} (retryable)`);
    }

    const data = await res.json() as { runId: string };
    log.info(`Triggered task ${taskId}: runId=${data.runId}`);
    await writeAuditLog({
        tenantId,
        eventType: 'agent.task.cron_completed',
        action: 'Cron Trigger Completed',
        resourceId: taskId,
        status: 'success',
        severity: 'info',
        details: `Agent ops scheduler triggered task ${taskId}, runId=${data.runId}`,
        metadata: { taskId, tenantId, runId: data.runId },
    });
}

let sweepInFlight = false;

/** Query active tasks, select those due, and enqueue one tick each. */
export async function sweep(boss: PgBoss): Promise<void> {
    if (sweepInFlight) {
        log.debug('Sweep skipped — previous sweep still in flight');
        return;
    }
    sweepInFlight = true;
    try {
        const nowMs = Date.now();
        const active = await loadActiveTasks();
        const due = selectDueTasks(active, nowMs, DUE_WINDOW_MS);
        for (const task of due) {
            try {
                await boss.send(
                    TICK_QUEUE,
                    { taskId: task.taskId, tenantId: task.tenantId } satisfies TaskTickData,
                    {
                        // Per-task de-dup within the due minute (and across replicas).
                        singletonKey: `task:${task.taskId}`,
                        singletonSeconds: 60,
                        retryLimit: 3,
                        retryDelay: 60,
                        retryBackoff: true,
                        expireInSeconds: 300,
                    },
                );
                // Interval tasks stay "due" until their anchor moves — advance it
                // now so the next sweep (30s away) doesn't enqueue again.
                await advanceIntervalAnchor(task, nowMs);
            } catch (err) {
                log.error(`Failed to enqueue tick for task ${task.taskId}`, { error: String(err) });
            }
        }
        if (due.length) log.info(`Enqueued ${due.length} due task tick(s)`, { active: active.length });
    } finally {
        sweepInFlight = false;
    }
}

export async function register(boss: PgBoss, executor: JobExecutor): Promise<void> {
    executor.registerHandler?.(TICK_QUEUE, handleAgentOpsTick);

    await boss.createQueue(TICK_QUEUE);
    await boss.updateQueue(TICK_QUEUE, {
        name: TICK_QUEUE,
        retryLimit: 3,
        expireInSeconds: 300,
        deadLetter: DEAD_LETTER_QUEUE,
    });

    // Single poller for all tasks. batchSize:5 lets independent tenants' ticks run
    // concurrently without one poller per task.
    await boss.work<TaskTickData>(TICK_QUEUE, { batchSize: 5 }, async (jobs) => {
        for (const job of jobs) {
            await executor.execute(TICK_QUEUE, job.data, { idempotencyKey: job.id });
        }
    });

    await sweep(boss);
    sweepTimer = setInterval(() => {
        sweep(boss).catch((err) => log.error('Sweep failed', { error: String(err) }));
    }, SWEEP_INTERVAL_MS);

    log.info(`Registered agent-ops sweeper on '${TICK_QUEUE}'; sweep every ${SWEEP_INTERVAL_MS / 1000}s`);
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Stop scheduling new sweeps. Call at the START of shutdown, before boss.stop(),
 *  so no tick is enqueued against a stopping boss while in-flight handlers drain. */
export function stopAgentOpsSweeper(): void {
    if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
    }
}

/** Close the module-owned DB handles. Call AFTER boss.stop() so draining tick
 *  handlers can still write their audit rows. */
export async function closeAgentOpsResources(): Promise<void> {
    try {
        if (_pool) { await _pool.end(); _pool = null; }
    } catch (err) {
        log.warn('Error closing agent-ops pool', { error: String(err) });
    }
    try {
        if (_prisma) { await _prisma.$disconnect(); _prisma = null; }
    } catch (err) {
        log.warn('Error disconnecting agent-ops prisma', { error: String(err) });
    }
}
