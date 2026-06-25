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
                eventType: 'schedule.schedule.created',
                action: 'Created Schedule',
                resourceType: 'Schedule',
                resourceId: result.id,
                resourceName: schedule.name,
                user: schedule.createdBy || 'system',
                userType: 'user',
                status: 'success',
                severity: 'medium',
                details: `Created schedule "${schedule.name}"`,
                tenantId,
                dataClassification: 'infrastructure',
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
                eventType: 'schedule.schedule.created',
                action: 'Created Schedule',
                resourceType: 'Schedule',
                resourceId: schedule.name,
                resourceName: schedule.name,
                user: 'system',
                userType: 'user',
                status: 'error',
                severity: 'high',
                details: `Failed to create schedule "${schedule.name}": ${(error as Error).message}`,
                tenantId,
                metadata: { tenantId },
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
        tenantId?: string,
        skipAudit = false
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

            if (!skipAudit) {
                await AuditService.logUserAction({
                    eventType: 'schedule.schedule.updated',
                    action: 'Updated Schedule',
                    resourceType: 'Schedule',
                    resourceId: scheduleId,
                    resourceName: result.name,
                    user: (updates as Record<string, unknown>).updatedBy as string || 'system',
                    userType: 'user',
                    status: 'success',
                    severity: 'medium',
                    details: `Updated schedule "${result.name}"`,
                    tenantId,
                    dataClassification: 'infrastructure',
                    metadata: { tenantId },
                });
            }

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
                eventType: 'schedule.schedule.deleted',
                action: 'Deleted Schedule',
                resourceType: 'Schedule',
                resourceId: idOrName,
                resourceName: schedule.name,
                user: deletedBy,
                userType: 'user',
                status: 'success',
                severity: 'high',
                details: `Deleted schedule "${schedule.name}"`,
                tenantId,
                dataClassification: 'infrastructure',
                metadata: { tenantId },
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
        const newActive = !currentSchedule.active;

        // Use updateSchedule but we'll log a specific "Toggled" event instead of generic "Updated"
        const usePg = process.env.USE_PG_SCHEDULES === 'true';
        let result: UISchedule;
        if (usePg) {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { SchedulePostgresRepository } = require('@/lib/db/repositories/schedule/postgres');
            const pgRepo = new SchedulePostgresRepository();
            result = await pgRepo.updateSchedule(currentSchedule.id, { active: newActive, updatedBy } as Partial<UISchedule>, tenantId, effectiveAccountId);
        } else {
            const repo = getScheduleRepository();
            result = await repo.updateSchedule(currentSchedule.id, { active: newActive, updatedBy } as Partial<UISchedule>, tenantId, effectiveAccountId);
        }

        await AuditService.logUserAction({
            eventType: 'schedule.schedule.toggled',
            action: 'Toggled Schedule',
            resourceType: 'Schedule',
            resourceId: currentSchedule.id,
            resourceName: currentSchedule.name,
            user: updatedBy,
            userType: 'user',
            status: 'success',
            severity: 'medium',
            details: `Toggled schedule "${currentSchedule.name}" to ${newActive ? 'active' : 'inactive'}`,
            tenantId,
            changeSet: { before: { active: currentSchedule.active }, after: { active: newActive } },
            metadata: { tenantId, active: newActive },
        });

        return result;
    }
}
