/**
 * IScheduleExecutionRepository
 *
 * Contract for schedule execution persistence.
 * Implemented by ScheduleExecutionDynamoRepository and ScheduleExecutionPostgresRepository.
 * The feature flag USE_PG_SCHEDULE_EXECUTIONS controls which implementation is active.
 */
import type { ScheduleExecution, UIScheduleExecution } from '@/lib/schedule-execution-service';

export interface IScheduleExecutionRepository {
    logExecution(execution: Omit<ScheduleExecution, 'executionId'>): Promise<ScheduleExecution>;
    getExecutionHistory(scheduleId: string, tenantId: string, limit?: number): Promise<UIScheduleExecution[]>;
    getRecentExecutions(tenantId: string, limit?: number): Promise<UIScheduleExecution[]>;
}
