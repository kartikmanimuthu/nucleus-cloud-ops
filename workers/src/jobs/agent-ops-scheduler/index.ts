import type PgBoss from 'pg-boss';
import { createLogger } from '../../lib/logger.js';
import type { JobExecutor } from '../../executor/index.js';

const log = createLogger('agent-ops-scheduler');

const QUEUE_PREFIX = 'agent-ops-task';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'internal-worker-key';
const WEB_UI_BASE_URL = process.env.WEB_UI_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

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
        const tasks = await prisma.agentOpsScheduledTask.findMany({
            where: { taskStatus: 'active', deletedAt: null },
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
        } else {
            const data = await res.json() as { runId: string };
            log.info(`Triggered task ${taskId}: runId=${data.runId}`);
        }
    } catch (err) {
        log.error(`Trigger error for task ${taskId}`, { error: String(err) });
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
