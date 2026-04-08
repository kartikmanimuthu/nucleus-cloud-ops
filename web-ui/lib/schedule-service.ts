// Schedule service — delegates to the repository layer via feature flags
// Use USE_PG_SCHEDULES=true to switch to PostgreSQL, DUAL_WRITE_SCHEDULES=true for dual-write
import { UISchedule } from './types';
import { AuditService } from './audit-service';
import { getScheduleRepository } from '@/lib/db/repository-factory';

// Re-export helpers for API routes that import them directly
export const buildSchedulePK = (tenantId: string, accountId: string) =>
    `TENANT#${tenantId}#ACCOUNT#${accountId}`;
export const buildScheduleSK = (scheduleId: string) => `SCHEDULE#${scheduleId}`;

export class ScheduleService {
    /**
     * Fetch all schedules with optional filters.
     * Delegates to the active repository (DynamoDB or PostgreSQL).
     */
    static async getSchedules(filters?: {
        statusFilter?: string;
        resourceFilter?: string;
        searchTerm?: string;
        tenantId?: string;
        accountId?: string;
        page?: number;
        limit?: number;
    }): Promise<{ schedules: UISchedule[], total: number }> {
        try {
            console.log('ScheduleService - Fetching schedules with filters:', filters);
            const tenantId = filters?.tenantId;
            const repo = getScheduleRepository();
            return await repo.getSchedules({
                tenantId,
                statusFilter: filters?.statusFilter,
                resourceFilter: filters?.resourceFilter,
                searchTerm: filters?.searchTerm,
                accountId: filters?.accountId,
                page: filters?.page,
                limit: filters?.limit,
            });
        } catch (error: unknown) {
            console.error('ScheduleService - Error fetching schedules:', error);
            return { schedules: [], total: 0 };
        }
    }

    /**
     * Fetch schedules with filtering support (legacy helper).
     */
    static async getSchedulesWithFilters(active?: boolean, searchTerm?: string): Promise<UISchedule[]> {
        const statusFilter = active === undefined ? undefined : (active ? 'active' : 'inactive');
        const result = await this.getSchedules({ statusFilter, searchTerm });
        return result.schedules;
    }

    /**
     * Get a specific schedule by ID or name.
     */
    static async getSchedule(
        idOrName: string,
        accountId?: string,
        tenantId?: string
    ): Promise<UISchedule | null> {
        try {
            const repo = getScheduleRepository();
            return await repo.getSchedule(idOrName, accountId, tenantId);
        } catch (error: unknown) {
            console.error('ScheduleService - Error fetching schedule:', error);
            return null;
        }
    }

    /**
     * Create a new schedule.
     * When USE_PG_SCHEDULES=true: writes to PostgreSQL (source of truth).
     * When DUAL_WRITE_SCHEDULES=true additionally: also writes to DynamoDB (best-effort).
     * When USE_PG_SCHEDULES=false: writes to DynamoDB only via repository factory.
     */
    static async createSchedule(
        schedule: Omit<UISchedule, 'id'>,
        tenantId: string
    ): Promise<UISchedule> {
        const usePg = process.env.USE_PG_SCHEDULES === 'true';

        try {
            let result: UISchedule;

            if (usePg) {
                // PostgreSQL is the source of truth
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { SchedulePostgresRepository } = require('@/lib/db/repositories/schedule/postgres');
                const pgRepo = new SchedulePostgresRepository();
                result = await pgRepo.createSchedule(schedule, tenantId);

            } else {
                const repo = getScheduleRepository();
                result = await repo.createSchedule(schedule, tenantId);
            }

            // Audit log (cross-cutting concern stays in service layer)
            await AuditService.logUserAction({
                action: 'Create Schedule',
                resourceType: 'schedule',
                resourceId: result.id,
                resourceName: schedule.name,
                user: schedule.createdBy || 'system',
                userType: 'user',
                status: 'success',
                details: `Created schedule "${schedule.name}"`,
                metadata: {
                    tenantId,
                    accountId: schedule.accounts?.[0],
                    scheduleName: schedule.name,
                    active: schedule.active,
                },
            });

            return result;
        } catch (error) {
            console.error('Error creating schedule:', error);
            await AuditService.logUserAction({
                action: 'Create Schedule',
                resourceType: 'schedule',
                resourceId: schedule.name,
                resourceName: schedule.name,
                user: 'system',
                userType: 'user',
                status: 'error',
                details: `Failed to create schedule "${schedule.name}": ${(error as Error).message}`,
            });
            throw error;
        }
    }

    /**
     * Update an existing schedule.
     * When USE_PG_SCHEDULES=true AND DUAL_WRITE_SCHEDULES=true: updates both stores.
     */
    static async updateSchedule(
        scheduleId: string,
        updates: Partial<Omit<UISchedule, 'name'>>,
        accountId?: string,
        tenantId?: string
    ): Promise<UISchedule> {
        const usePg = process.env.USE_PG_SCHEDULES === 'true';

        try {
            let result: UISchedule;

            if (usePg) {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { SchedulePostgresRepository } = require('@/lib/db/repositories/schedule/postgres');
                const pgRepo = new SchedulePostgresRepository();
                result = await pgRepo.updateSchedule(scheduleId, updates, tenantId, accountId);

            } else {
                const repo = getScheduleRepository();
                result = await repo.updateSchedule(scheduleId, updates, tenantId, accountId);
            }

            await AuditService.logUserAction({
                action: 'Update Schedule',
                resourceType: 'schedule',
                resourceId: scheduleId,
                resourceName: result.name,
                user: (updates as Record<string, unknown>).updatedBy as string || 'system',
                userType: 'user',
                status: 'success',
                details: `Updated schedule "${result.name}"`,
            });

            return result;
        } catch (error) {
            console.error('Error updating schedule:', error);
            throw error;
        }
    }

    /**
     * Delete a schedule.
     * When USE_PG_SCHEDULES=true AND DUAL_WRITE_SCHEDULES=true: deletes from both stores.
     */
    static async deleteSchedule(
        idOrName: string,
        accountId?: string,
        deletedBy: string = 'system',
        tenantId?: string
    ): Promise<void> {
        const usePg = process.env.USE_PG_SCHEDULES === 'true';

        try {
            // Fetch schedule name for the audit log before deleting
            const schedule = await this.getSchedule(idOrName, accountId, tenantId);
            if (!schedule) return; // Nothing to delete

            if (usePg) {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { SchedulePostgresRepository } = require('@/lib/db/repositories/schedule/postgres');
                const pgRepo = new SchedulePostgresRepository();
                await pgRepo.deleteSchedule(idOrName, tenantId, accountId);

            } else {
                const repo = getScheduleRepository();
                await repo.deleteSchedule(idOrName, tenantId, accountId);
            }

            await AuditService.logUserAction({
                action: 'Delete Schedule',
                resourceType: 'schedule',
                resourceId: idOrName,
                resourceName: schedule.name,
                user: deletedBy,
                userType: 'user',
                status: 'success',
                details: `Deleted schedule "${schedule.name}"`,
            });
        } catch (error: unknown) {
            console.error('Error deleting schedule:', error);
        }
    }

    /**
     * Toggle schedule active status.
     */
    static async toggleScheduleStatus(
        idOrName: string,
        accountId?: string,
        updatedBy: string = 'system',
        tenantId?: string
    ): Promise<UISchedule> {
        const currentSchedule = await this.getSchedule(idOrName, accountId, tenantId);
        if (!currentSchedule) {
            throw new Error('Schedule not found');
        }

        const effectiveAccountId = accountId || currentSchedule.accounts?.[0];
        return await this.updateSchedule(
            currentSchedule.id,
            { active: !currentSchedule.active, updatedBy } as Partial<UISchedule>,
            effectiveAccountId,
            tenantId
        );
    }
}
