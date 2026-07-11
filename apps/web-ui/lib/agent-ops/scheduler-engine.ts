/**
 * Scheduler Engine — pg-boss-based cron scheduler.
 *
 * On startup: workers load all active tasks from PostgreSQL and register pg-boss schedules.
 * On tick: worker triggers execution via HTTP POST to the trigger endpoint.
 *
 * Web-ui side (this file) is producer-only: schedule/unschedule via getBoss().
 * The workers process handles actual job execution.
 */

import type { ScheduledTask } from './types';
import { getBoss } from '../boss-client';

const QUEUE_PREFIX = 'agent-ops-task';

function queueName(taskId: string): string {
    return `${QUEUE_PREFIX}:${taskId}`;
}

/**
 * No-op — workers handle startup registration now.
 * Kept for backward compatibility with callers.
 */
export async function initializeScheduler(): Promise<void> {
    // Workers process loads active tasks and registers pg-boss schedules on startup.
    // Web-ui only uses registerTask/unregisterTask for on-demand schedule changes.
}

export async function registerTask(task: ScheduledTask): Promise<void> {
    const boss = await getBoss();
    const queue = queueName(task.taskId);

    // Interval tasks have no cron expression — the workers sweeper fires them
    // off nextRunAt. Drop any stale pg-boss schedule (e.g. a task switched from
    // cron to interval) and skip registration.
    if (task.scheduleType === 'interval') {
        try { await boss.unschedule(queue); } catch { /* no existing schedule */ }
        return;
    }

    await boss.createQueue(queue);

    // Remove existing schedule before re-registering (idempotent)
    try { await boss.unschedule(queue); } catch { /* no existing schedule */ }

    await boss.schedule(queue, task.cronExpression, {
        taskId: task.taskId,
        tenantId: task.tenantId,
    }, { tz: task.timezone });

    console.log(`[Scheduler] Registered task ${task.taskId} via pg-boss (${task.cronExpression} ${task.timezone})`);
}

export async function unregisterTask(taskId: string): Promise<void> {
    const boss = await getBoss();
    const queue = queueName(taskId);

    try {
        await boss.unschedule(queue);
        console.log(`[Scheduler] Unregistered task ${taskId}`);
    } catch {
        // Queue/schedule may not exist — safe to ignore
    }
}

/**
 * No-op — pg-boss handles cleanup via the workers process.
 */
export function shutdownScheduler(): void {
    // pg-boss lifecycle managed by the workers process
}
