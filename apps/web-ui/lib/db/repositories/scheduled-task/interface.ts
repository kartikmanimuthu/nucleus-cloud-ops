/**
 * IScheduledTaskRepository
 *
 * Contract for scheduled task persistence.
 * Implemented by ScheduledTaskDynamoRepository and ScheduledTaskPostgresRepository.
 * The feature flag USE_PG_AGENT_OPS controls which implementation is active.
 */
import type { ScheduledTask, AgentOpsStatus, AgentMode } from '@/lib/agent-ops/types';

export interface CreateScheduledTaskParams {
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
    knowledgeBaseIds?: string[];
    notification: ScheduledTask['notification'];
    createdBy: string;
}

export interface UpdateScheduledTaskParams {
    name?: string;
    description?: string;
    cronExpression?: string;
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

export interface IScheduledTaskRepository {
    createScheduledTask(params: CreateScheduledTaskParams): Promise<ScheduledTask>;
    getScheduledTask(tenantId: string, taskId: string): Promise<ScheduledTask | null>;
    listScheduledTasks(tenantId: string): Promise<ScheduledTask[]>;
    listAllActiveTasks(): Promise<ScheduledTask[]>;
    updateScheduledTask(tenantId: string, taskId: string, updates: UpdateScheduledTaskParams): Promise<ScheduledTask | null>;
    pauseScheduledTask(tenantId: string, taskId: string): Promise<void>;
    resumeScheduledTask(tenantId: string, taskId: string): Promise<ScheduledTask | null>;
    deleteScheduledTask(tenantId: string, taskId: string): Promise<void>;
    updateLastRun(tenantId: string, taskId: string, runId: string, status: AgentOpsStatus): Promise<void>;
    tryAcquireExecutionLock(taskId: string, scheduledAt: string): Promise<boolean>;
}
