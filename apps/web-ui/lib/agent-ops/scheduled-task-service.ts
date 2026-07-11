/**
 * Scheduled Task Service
 *
 * CRUD operations for scheduled tasks + execution lock.
 * Delegates all persistence to the repository factory (USE_PG_AGENT_OPS feature flag).
 */

import { getScheduledTaskRepository } from '@/lib/db/repository-factory';
import type { CreateScheduledTaskParams, UpdateScheduledTaskParams } from '@/lib/db/repositories/scheduled-task/interface';
import type { ScheduledTask, AgentOpsStatus } from './types';

// ─── CRUD ──────────────────────────────────────────────────────────────

export async function createScheduledTask(params: CreateScheduledTaskParams): Promise<ScheduledTask> {
    const task = await getScheduledTaskRepository().createScheduledTask(params);
    console.log(`[ScheduledTaskService] Created task: ${task.taskId}`);
    return task;
}

export async function getScheduledTask(tenantId: string, taskId: string): Promise<ScheduledTask | null> {
    return getScheduledTaskRepository().getScheduledTask(tenantId, taskId);
}

export async function listScheduledTasks(tenantId: string): Promise<ScheduledTask[]> {
    return getScheduledTaskRepository().listScheduledTasks(tenantId);
}

export async function listAllActiveTasks(): Promise<ScheduledTask[]> {
    return getScheduledTaskRepository().listAllActiveTasks();
}

export async function updateScheduledTask(
    tenantId: string,
    taskId: string,
    updates: UpdateScheduledTaskParams
): Promise<ScheduledTask | null> {
    return getScheduledTaskRepository().updateScheduledTask(tenantId, taskId, updates);
}

export async function pauseScheduledTask(tenantId: string, taskId: string): Promise<void> {
    return getScheduledTaskRepository().pauseScheduledTask(tenantId, taskId);
}

export async function resumeScheduledTask(tenantId: string, taskId: string): Promise<ScheduledTask | null> {
    return getScheduledTaskRepository().resumeScheduledTask(tenantId, taskId);
}

export async function deleteScheduledTask(tenantId: string, taskId: string): Promise<void> {
    return getScheduledTaskRepository().deleteScheduledTask(tenantId, taskId);
}

export async function updateLastRun(
    tenantId: string,
    taskId: string,
    runId: string,
    status: AgentOpsStatus,
    opts?: { incrementRunCount?: boolean }
): Promise<void> {
    return getScheduledTaskRepository().updateLastRun(tenantId, taskId, runId, status, opts);
}

// ─── Schedule Validation ───────────────────────────────────────────────

export const MIN_INTERVAL_MINUTES = 5;          // floor — protects the sweeper + LLM budget
export const MAX_INTERVAL_MINUTES = 7 * 24 * 60; // 1 week

/**
 * Validate the schedule fields of a create/update payload. Returns an error
 * message (for a 400 response) or null when valid.
 */
export function validateScheduleInput(input: {
    scheduleType?: string;
    cronExpression?: string;
    intervalMinutes?: unknown;
}): string | null {
    const scheduleType = input.scheduleType ?? 'cron';
    if (scheduleType !== 'cron' && scheduleType !== 'interval') {
        return `scheduleType must be 'cron' or 'interval'`;
    }
    if (scheduleType === 'interval') {
        const minutes = Number(input.intervalMinutes);
        if (!Number.isInteger(minutes) || minutes < MIN_INTERVAL_MINUTES || minutes > MAX_INTERVAL_MINUTES) {
            return `intervalMinutes must be an integer between ${MIN_INTERVAL_MINUTES} and ${MAX_INTERVAL_MINUTES}`;
        }
        return null;
    }
    if (!input.cronExpression || !input.cronExpression.trim()) {
        return 'cronExpression is required for cron schedules';
    }
    return null;
}

// ─── Execution Lock ────────────────────────────────────────────────────

/**
 * Acquire execution lock — returns true if lock acquired, false if already exists.
 * PostgreSQL repo uses ON CONFLICT (taskId, scheduledAt) DO NOTHING (AOPS-04).
 * Prevents duplicate runs across ECS instances.
 */
export async function tryAcquireExecutionLock(taskId: string, scheduledAt: string): Promise<boolean> {
    return getScheduledTaskRepository().tryAcquireExecutionLock(taskId, scheduledAt);
}
