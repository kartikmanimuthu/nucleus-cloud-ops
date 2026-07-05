import type PgBoss from 'pg-boss';
import { createLogger } from '../../lib/logger.js';
import type { JobExecutor } from '../../executor/index.js';
import { Pool, type PoolClient } from 'pg';
import { env } from '../../env.js';
import { diffScheduleSync, type ActiveTaskRow, type RegisteredEntry } from './sync.js';

const log = createLogger('agent-ops-scheduler');

const QUEUE_PREFIX = 'agent-ops-task';
const INTERNAL_API_KEY = env.INTERNAL_API_KEY || 'internal-worker-key';
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

function queueName(taskId: string): string {
    return `${QUEUE_PREFIX}:${taskId}`;
}

const SYNC_INTERVAL_MS = 60_000;

const registeredSchedules = new Map<string, RegisteredEntry>();
const startedConsumers = new Set<string>();

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
        select: { taskId: true, tenantId: true, cronExpression: true, timezone: true },
    });
}

export async function handleAgentOpsTick(jobData: unknown): Promise<void> {
    const { taskId, tenantId } = jobData as TaskTickData;
    log.info(`Tick: task=${taskId} tenant=${tenantId}`);

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

    try {
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
        } else {
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
    } catch (err) {
        log.error(`Trigger error for task ${taskId}`, { error: String(err) });

        await writeAuditLog({
            tenantId,
            eventType: 'agent.task.cron_failed',
            action: 'Cron Trigger Error',
            resourceId: taskId,
            status: 'error',
            severity: 'high',
            details: `Agent ops scheduler error for task ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
            metadata: { taskId, tenantId },
        });
    }
}

async function ensureTaskRegistered(boss: PgBoss, executor: JobExecutor, task: ActiveTaskRow): Promise<void> {
    const queue = queueName(task.taskId);
    await boss.createQueue(queue);

    // pg-boss allows one work() subscription per queue per process
    if (!startedConsumers.has(queue)) {
        executor.registerHandler?.(queue, handleAgentOpsTick);
        await boss.work(queue, { batchSize: 1 }, async (jobs: PgBoss.Job<TaskTickData>[]) => {
            for (const job of jobs) {
                await executor.execute(queue, job.data);
            }
        });
        startedConsumers.add(queue);
    }

    // schedule() upserts by queue name — safe for both add and update
    await boss.schedule(queue, task.cronExpression, {
        taskId: task.taskId,
        tenantId: task.tenantId,
    } satisfies TaskTickData, { tz: task.timezone });

    registeredSchedules.set(task.taskId, {
        cronExpression: task.cronExpression,
        timezone: task.timezone,
    });
}

export async function syncSchedules(boss: PgBoss, executor: JobExecutor): Promise<void> {
    const active = await loadActiveTasks();
    const diff = diffScheduleSync(active, registeredSchedules);

    for (const task of [...diff.toAdd, ...diff.toUpdate]) {
        try {
            await ensureTaskRegistered(boss, executor, task);
            log.info(`Registered schedule for task ${task.taskId} (${task.cronExpression} ${task.timezone})`);
        } catch (err) {
            log.error(`Failed to register task ${task.taskId}`, { error: String(err) });
        }
    }

    for (const taskId of diff.toRemove) {
        try {
            await boss.unschedule(queueName(taskId));
        } catch { /* schedule may not exist — safe to ignore */ }
        registeredSchedules.delete(taskId);
        log.info(`Unscheduled task ${taskId}`);
    }
}

export async function register(boss: PgBoss, executor: JobExecutor): Promise<void> {
    await syncSchedules(boss, executor);

    setInterval(() => {
        syncSchedules(boss, executor).catch(err =>
            log.error('Schedule re-sync failed', { error: String(err) }),
        );
    }, SYNC_INTERVAL_MS);

    log.info(`Registered ${registeredSchedules.size} agent-ops scheduled task(s); re-sync every ${SYNC_INTERVAL_MS / 1000}s`);
}
