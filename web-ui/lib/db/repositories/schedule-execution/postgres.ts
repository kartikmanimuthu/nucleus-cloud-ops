/**
 * ScheduleExecutionPostgresRepository
 *
 * PostgreSQL implementation of IScheduleExecutionRepository using Prisma ORM.
 * Reads/writes the `schedule_executions` table (defined in prisma/schema.prisma).
 *
 * Key differences vs DynamoDB path:
 * - expiresAt (DateTime) replaces DynamoDB TTL — set to now + 90 days on insert
 * - Server-side filtering with WHERE tenantId on every query
 * - Server-side ordering with orderBy executionTime DESC
 *
 * Multi-tenant safety: every query is scoped by tenantId — no cross-tenant data access.
 */
import { getPrismaClient } from '@/lib/db/pg-config';
import type { ScheduleExecution, UIScheduleExecution } from '@/lib/schedule-execution-service';
import type { IScheduleExecutionRepository } from './interface';

// 90 days in milliseconds
const EXECUTION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export class ScheduleExecutionPostgresRepository implements IScheduleExecutionRepository {
    async logExecution(
        execution: Omit<ScheduleExecution, 'executionId'>
    ): Promise<ScheduleExecution> {
        try {
            const executionId = `exec-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            const expiresAt = new Date(Date.now() + EXECUTION_TTL_MS);
            const executionTime = new Date(execution.executionTime || Date.now());

            const record = await getPrismaClient().scheduleExecution.create({
                data: {
                    tenantId: execution.tenantId,
                    executionId,
                    scheduleId: execution.scheduleId,
                    accountId: execution.accountId,
                    status: execution.status,
                    executionTime,
                    resourcesStarted: execution.resourcesStarted || 0,
                    resourcesStopped: execution.resourcesStopped || 0,
                    resourcesFailed: execution.resourcesFailed || 0,
                    duration: execution.duration,
                    errorMessage: execution.errorMessage,
                    details: (execution.details as object) || undefined,
                    scheduleMetadata: (execution.schedule_metadata as object) || undefined,
                    expiresAt,
                },
            });

            console.log(
                `[ScheduleExecutionPostgresRepository] Logged execution ${executionId} for schedule ${execution.scheduleId}`
            );

            return {
                executionId,
                ...execution,
                executionTime: record.executionTime.toISOString(),
            };
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error(
                '[ScheduleExecutionPostgresRepository] Error logging execution:',
                error
            );
            throw new Error(`Failed to log execution: ${msg}`);
        }
    }

    async getExecutionHistory(
        scheduleId: string,
        tenantId: string,
        limit: number = 50
    ): Promise<UIScheduleExecution[]> {
        try {
            const rows = await getPrismaClient().scheduleExecution.findMany({
                where: { tenantId, scheduleId },
                orderBy: { executionTime: 'desc' },
                take: limit,
            });

            return rows.map((r) => this.transformToUIExecution(r));
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error(
                '[ScheduleExecutionPostgresRepository] Error getting execution history:',
                error
            );
            throw new Error(`Failed to get execution history: ${msg}`);
        }
    }

    async getRecentExecutions(
        tenantId: string,
        limit: number = 100
    ): Promise<UIScheduleExecution[]> {
        try {
            const rows = await getPrismaClient().scheduleExecution.findMany({
                where: { tenantId },
                orderBy: { executionTime: 'desc' },
                take: limit,
            });

            return rows.map((r) => this.transformToUIExecution(r));
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error(
                '[ScheduleExecutionPostgresRepository] Error getting recent executions:',
                error
            );
            throw new Error(`Failed to get recent executions: ${msg}`);
        }
    }

    private transformToUIExecution(record: {
        id: string;
        tenantId: string;
        executionId: string;
        scheduleId: string;
        accountId: string;
        status: string;
        executionTime: Date;
        resourcesStarted: number;
        resourcesStopped: number;
        resourcesFailed: number;
        duration: number | null;
        errorMessage: string | null;
        details: unknown;
        scheduleMetadata: unknown;
        expiresAt: Date;
    }): UIScheduleExecution {
        const time = record.executionTime.toISOString();
        return {
            id: record.executionId,
            executionId: record.executionId,
            tenantId: record.tenantId,
            accountId: record.accountId,
            scheduleId: record.scheduleId,
            executionTime: time,
            status: record.status as ScheduleExecution['status'],
            resourcesStarted: record.resourcesStarted,
            resourcesStopped: record.resourcesStopped,
            resourcesFailed: record.resourcesFailed,
            duration: record.duration ?? undefined,
            errorMessage: record.errorMessage ?? undefined,
            details: (record.details as Record<string, unknown>) ?? undefined,
            schedule_metadata: record.scheduleMetadata,
            startTime: time,
        };
    }
}
