// Schedule execution service — delegates to the repository layer via feature flags
// Use USE_PG_SCHEDULES=true to switch to PostgreSQL backend
import { DEFAULT_TENANT_ID } from './aws-config';
import { getScheduleExecutionRepository } from '@/lib/db/repository-factory';

export interface ScheduleExecution {
    executionId: string;
    tenantId: string;
    accountId: string;
    scheduleId: string;
    executionTime: string;
    status: 'pending' | 'running' | 'success' | 'failed' | 'partial';
    resourcesStarted?: number;
    resourcesStopped?: number;
    resourcesFailed?: number;
    duration?: number; // in seconds
    errorMessage?: string;
    details?: Record<string, any>;
    schedule_metadata?: any; // Add schedule_metadata for UI to display resource details
}

export interface UIScheduleExecution extends ScheduleExecution {
    id: string;
    startTime?: string; // For compatibility with backend naming
}

export class ScheduleExecutionService {
    /**
     * Log a schedule execution result.
     * Delegates to the active repository (DynamoDB or PostgreSQL).
     */
    static async logExecution(
        execution: Omit<ScheduleExecution, 'executionId'>
    ): Promise<ScheduleExecution> {
        try {
            const repo = getScheduleExecutionRepository();
            return await repo.logExecution(execution);
        } catch (error: unknown) {
            console.error('ScheduleExecutionService - Error logging execution:', error);
            throw error;
        }
    }

    /**
     * Get executions for a specific schedule.
     * Delegates to getExecutionHistory in the active repository.
     */
    static async getExecutionsForSchedule(
        scheduleId: string,
        _accountId: string, // Kept for interface compatibility
        options?: {
            limit?: number;
            startDate?: string;
            endDate?: string;
        },
        tenantId: string = DEFAULT_TENANT_ID
    ): Promise<UIScheduleExecution[]> {
        try {
            const repo = getScheduleExecutionRepository();
            return await repo.getExecutionHistory(scheduleId, tenantId, options?.limit);
        } catch (error: unknown) {
            console.error('ScheduleExecutionService - Error fetching executions:', error);
            return [];
        }
    }

    /**
     * Get a single execution by ID.
     * Uses getExecutionHistory and filters in memory (repository does not expose getById).
     */
    static async getExecutionById(
        scheduleId: string,
        executionId: string,
        tenantId: string = DEFAULT_TENANT_ID
    ): Promise<UIScheduleExecution | null> {
        try {
            const repo = getScheduleExecutionRepository();
            const executions = await repo.getExecutionHistory(scheduleId, tenantId, 200);
            return executions.find((e) => e.executionId === executionId) || null;
        } catch (error: unknown) {
            console.error('ScheduleExecutionService - Error fetching execution by ID:', error);
            return null;
        }
    }

    /**
     * Get all recent executions across all schedules.
     * Delegates to getRecentExecutions in the active repository.
     */
    static async getRecentExecutions(options?: {
        limit?: number;
        status?: string;
        tenantId?: string;
    }): Promise<UIScheduleExecution[]> {
        try {
            const tenantId = options?.tenantId || DEFAULT_TENANT_ID;
            const repo = getScheduleExecutionRepository();
            const executions = await repo.getRecentExecutions(tenantId, options?.limit);

            // In-memory status filter if provided
            if (options?.status) {
                return executions.filter((e) => e.status === options.status);
            }

            return executions;
        } catch (error: unknown) {
            console.error('ScheduleExecutionService - Error fetching recent executions:', error);
            return [];
        }
    }
}
