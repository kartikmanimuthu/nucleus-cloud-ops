/**
 * IScheduledTaskRepository
 *
 * Contract for scheduled task persistence.
 * Implemented by ScheduledTaskDynamoRepository and ScheduledTaskPostgresRepository.
 * The feature flag USE_PG_AGENT_OPS controls which implementation is active.
 */
import type { ScheduledTask, AgentOpsStatus, AgentMode, ScheduleType } from '@/lib/agent-ops/types';

export interface CreateScheduledTaskParams {
    tenantId: string;
    name: string;
    description: string;
    scheduleType?: ScheduleType;   // default 'cron'
    cronExpression: string;        // empty string for interval tasks
    intervalMinutes?: number;      // required when scheduleType === 'interval'
    timezone: string;
    mode: AgentMode;
    autoApprove: boolean;
    model?: string;
    accountId?: string;
    accountName?: string;
    mcpServerIds?: string[];
    knowledgeBaseIds?: string[];
    notification: ScheduledTask['notification'];
    /** Client-supplied display string. Not an identity. */
    createdBy: string;
    /**
     * The creator's identity, resolved server-side from the session. The task's
     * stored grant is re-checked against THIS user at every execution
     * (see lib/agent-ops/scheduled-task-permission.ts), so a caller must never be
     * able to supply it from the request body.
     */
    createdByUserId?: string;
    /** Creation-time role snapshot — recorded for audit, never used to authorize. */
    createdByRoleId?: string;
}

export interface UpdateScheduledTaskParams {
    name?: string;
    description?: string;
    scheduleType?: ScheduleType;
    cronExpression?: string;
    intervalMinutes?: number | null;
    timezone?: string;
    mode?: AgentMode;
    autoApprove?: boolean;
    model?: string;
    accountId?: string;
    accountName?: string;
    mcpServerIds?: string[];
    knowledgeBaseIds?: string[];
    notification?: ScheduledTask['notification'];
}

export interface TaskListQuery {
    tenantId: string;
    page?: number;
    limit?: number;
    sortBy?: 'name' | 'taskStatus' | 'nextRunAt' | 'lastRunAt' | 'createdAt' | 'updatedAt' | 'runCount';
    sortDir?: 'asc' | 'desc';
}

export interface TaskListStats {
    active: number;
    paused: number;
    totalRuns: number;
}

export interface TaskListResult {
    tasks: ScheduledTask[];
    total: number;
    stats: TaskListStats;
}

export interface IScheduledTaskRepository {
    createScheduledTask(params: CreateScheduledTaskParams): Promise<ScheduledTask>;
    getScheduledTask(tenantId: string, taskId: string): Promise<ScheduledTask | null>;
    listScheduledTasks(query: TaskListQuery): Promise<TaskListResult>;
    listAllActiveTasks(): Promise<ScheduledTask[]>;
    updateScheduledTask(tenantId: string, taskId: string, updates: UpdateScheduledTaskParams): Promise<ScheduledTask | null>;
    pauseScheduledTask(tenantId: string, taskId: string): Promise<void>;
    resumeScheduledTask(tenantId: string, taskId: string): Promise<ScheduledTask | null>;
    deleteScheduledTask(tenantId: string, taskId: string): Promise<void>;
    updateLastRun(
        tenantId: string,
        taskId: string,
        runId: string,
        status: AgentOpsStatus,
        opts?: { incrementRunCount?: boolean }
    ): Promise<void>;
    tryAcquireExecutionLock(taskId: string, scheduledAt: string): Promise<boolean>;
}
