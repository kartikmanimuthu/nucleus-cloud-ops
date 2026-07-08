/**
 * IScheduleExecutionRepository
 *
 * Contract for schedule execution persistence.
 * Implemented by ScheduleExecutionDynamoRepository and ScheduleExecutionPostgresRepository.
 * The feature flag USE_PG_SCHEDULE_EXECUTIONS controls which implementation is active.
 */
import type { ScheduleExecution, UIScheduleExecution } from '@/lib/schedule-execution-service';

export interface PagedExecutions {
    executions: UIScheduleExecution[];
    total: number;
}

export interface IScheduleExecutionRepository {
    logExecution(execution: Omit<ScheduleExecution, 'executionId'>): Promise<ScheduleExecution>;
    getExecutionHistory(scheduleId: string, tenantId: string, limit?: number): Promise<UIScheduleExecution[]>;
    /** Paginated execution history for one schedule, plus the total row count for the schedule. */
    getExecutionHistoryPaged(
        scheduleId: string,
        tenantId: string,
        opts: { offset: number; limit: number },
    ): Promise<PagedExecutions>;
    getRecentExecutions(tenantId: string, limit?: number): Promise<UIScheduleExecution[]>;
}
