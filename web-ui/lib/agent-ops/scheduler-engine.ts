/**
 * Scheduler Engine — In-process cron scheduler (singleton via globalThis).
 *
 * On startup: loads all active tasks from DDB and registers croner jobs.
 * On tick: acquires execution lock → creates run → fire-and-forget executeAgentRun.
 */

import { Cron } from 'croner';
import type { ScheduledTask } from './types';

const g = globalThis as typeof globalThis & {
    _schedulerJobs?: Map<string, Cron>;
    _schedulerInitialized?: boolean;
};

function getJobs(): Map<string, Cron> {
    if (!g._schedulerJobs) g._schedulerJobs = new Map();
    return g._schedulerJobs;
}

export async function initializeScheduler(): Promise<void> {
    if (g._schedulerInitialized) return;
    g._schedulerInitialized = true;

    console.log('[Scheduler] Initializing...');
    try {
        const { listAllActiveTasks } = await import('./scheduled-task-service');
        const tasks = await listAllActiveTasks();
        for (const task of tasks) {
            registerTask(task);
        }
        console.log(`[Scheduler] Registered ${tasks.length} active tasks`);
    } catch (err) {
        console.error('[Scheduler] Init failed:', err);
    }
}

export function registerTask(task: ScheduledTask): void {
    unregisterTask(task.taskId);
    try {
        const job = new Cron(
            task.cronExpression,
            { timezone: task.timezone, protect: true },
            () => handleTick(task, new Date().toISOString())
        );
        getJobs().set(task.taskId, job);
        console.log(`[Scheduler] Registered task ${task.taskId} (${task.cronExpression} ${task.timezone})`);
    } catch (err) {
        console.error(`[Scheduler] Failed to register task ${task.taskId}:`, err);
    }
}

export function unregisterTask(taskId: string): void {
    const job = getJobs().get(taskId);
    if (job) {
        job.stop();
        getJobs().delete(taskId);
    }
}

async function handleTick(task: ScheduledTask, scheduledAt: string): Promise<void> {
    console.log(`[Scheduler] Tick: task=${task.taskId} scheduledAt=${scheduledAt}`);
    try {
        const { tryAcquireExecutionLock, updateLastRun } = await import('./scheduled-task-service');
        const { agentOpsService } = await import('./agent-ops-service');
        const { executeAgentRun } = await import('./agent-executor');
        const { notifyScheduledRunResult } = await import('./scheduled-notifier');

        const locked = await tryAcquireExecutionLock(task.taskId, scheduledAt);
        if (!locked) {
            console.log(`[Scheduler] Lock not acquired for task ${task.taskId} — skipping (duplicate)`);
            return;
        }

        const run = await agentOpsService.createRun({
            tenantId: task.tenantId,
            source: 'scheduled',
            taskDescription: task.description,
            mode: task.mode,
            autoApprove: task.autoApprove,
            model: task.model,
            accountId: task.accountId,
            accountName: task.accountName,
            mcpServerIds: task.mcpServerIds,
            trigger: { taskId: task.taskId, taskName: task.name, scheduledAt },
        });

        // Fire-and-forget
        executeAgentRun(run)
            .then(async () => {
                const freshRun = await agentOpsService.getRun(task.tenantId, run.runId);
                const status = freshRun?.status ?? 'completed';
                await updateLastRun(task.tenantId, task.taskId, run.runId, status);
                if (freshRun) await notifyScheduledRunResult(task, freshRun);
            })
            .catch(async (err) => {
                console.error(`[Scheduler] Run ${run.runId} failed:`, err);
                await updateLastRun(task.tenantId, task.taskId, run.runId, 'failed');
            });

    } catch (err) {
        console.error(`[Scheduler] handleTick error for task ${task.taskId}:`, err);
    }
}

export function shutdownScheduler(): void {
    for (const [taskId, job] of getJobs()) {
        job.stop();
        console.log(`[Scheduler] Stopped task ${taskId}`);
    }
    getJobs().clear();
    g._schedulerInitialized = false;
}
