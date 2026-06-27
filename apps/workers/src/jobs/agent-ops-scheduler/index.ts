import type PgBoss from 'pg-boss';
import { createLogger } from '../../lib/logger.js';
import type { JobExecutor } from '../../executor/index.js';
import { Pool, type PoolClient } from 'pg';
import { env } from '../../env.js';

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

async function loadActiveTasks(): Promise<Array<{ taskId: string; tenantId: string; cronExpression: string; timezone: string }>> {
    // Direct Prisma query — workers share DATABASE_URL with web-ui
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();
    try {
        const tasks = await prisma.scheduledTask.findMany({
            where: { taskStatus: 'active' },
            select: { taskId: true, tenantId: true, cronExpression: true, timezone: true },
        });
        return tasks;
    } finally {
        await prisma.$disconnect();
    }
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

export async function register(boss: PgBoss, executor: JobExecutor): Promise<void> {
    const tasks = await loadActiveTasks();

    for (const task of tasks) {
        const queue = queueName(task.taskId);
        await boss.createQueue(queue);
        executor.registerHandler?.(queue, handleAgentOpsTick);
        await boss.schedule(queue, task.cronExpression, {
            taskId: task.taskId,
            tenantId: task.tenantId,
        } satisfies TaskTickData, { tz: task.timezone });

        await boss.work(queue, { batchSize: 1 }, async (jobs: PgBoss.Job<TaskTickData>[]) => {
            for (const job of jobs) {
                await executor.execute(queue, job.data);
            }
        });
    }

    log.info(`Registered ${tasks.length} agent-ops scheduled task(s)`);
}
