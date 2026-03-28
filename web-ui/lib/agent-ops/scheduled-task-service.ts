/**
 * Scheduled Task Service
 *
 * CRUD operations for scheduled tasks + execution lock.
 * Delegates all persistence to the repository factory (USE_PG_AGENT_OPS feature flag).
 */

import { getScheduledTaskRepository } from '@/lib/db/repository-factory';
import type { ScheduledTask, AgentMode, AgentOpsStatus } from './types';

// ─── CRUD ──────────────────────────────────────────────────────────────

export async function createScheduledTask(params: {
    tenantId: string;
    name: string;
    description: string;
    cronExpression: string;
    timezone: string;
    mode: AgentMode;
    autoApprove: boolean;
    model?: string;
    accountId?: string;
    accountName?: string;
    mcpServerIds?: string[];
    notification: ScheduledTask['notification'];
    createdBy: string;
}): Promise<ScheduledTask> {
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
    updates: Partial<Pick<ScheduledTask, 'name' | 'description' | 'cronExpression' | 'timezone' | 'mode' | 'autoApprove' | 'model' | 'accountId' | 'accountName' | 'mcpServerIds' | 'notification'>>
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
    status: AgentOpsStatus
): Promise<void> {
    return getScheduledTaskRepository().updateLastRun(tenantId, taskId, runId, status);
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
