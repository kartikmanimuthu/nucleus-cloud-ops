/**
 * SchedulePostgresRepository
 *
 * PostgreSQL implementation of IScheduleRepository using Prisma ORM.
 * Reads/writes the `schedules` table (defined in prisma/schema.prisma).
 *
 * Key improvement over DynamoDB path: getSchedules uses server-side WHERE/ILIKE/LIMIT/OFFSET
 * instead of fetching all records and filtering in memory.
 *
 * Multi-tenant safety: every query is scoped by tenantId — no cross-tenant data access.
 */
import { getPrismaClient } from '@/lib/db/pg-config';
import type { UISchedule } from '@/lib/types';
import type { IScheduleRepository, ScheduleFilters, SchedulePage } from './interface';

export class SchedulePostgresRepository implements IScheduleRepository {
    async getSchedules(filters: ScheduleFilters): Promise<SchedulePage> {
        try {
            const {
                tenantId,
                searchTerm,
                statusFilter,
                resourceFilter,
                accountId,
                page = 1,
                limit = 20,
            } = filters;

            const where: Record<string, unknown> = { tenantId };

            if (searchTerm?.trim()) {
                where.OR = [
                    { name: { contains: searchTerm, mode: 'insensitive' } },
                    { description: { contains: searchTerm, mode: 'insensitive' } },
                ];
            }

            if (statusFilter && statusFilter !== 'all') {
                where.active = statusFilter === 'active';
            }

            if (accountId) {
                where.accountId = accountId;
            }

            const skip = (page - 1) * limit;

            const [total, rows] = await Promise.all([
                getPrismaClient().schedule.count({ where }),
                getPrismaClient().schedule.findMany({
                    where,
                    skip,
                    take: limit,
                    orderBy: { createdAt: 'desc' },
                }),
            ]);

            let schedules = rows.map((r) => this.transformToUISchedule(r));

            // Apply resourceFilter in memory — resources is a Json column
            if (resourceFilter && resourceFilter !== 'all') {
                schedules = schedules.filter(
                    (s) => s.resourceTypes && s.resourceTypes.includes(resourceFilter)
                );
            }

            return { schedules, total };
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[SchedulePostgresRepository] Error in getSchedules:', error);
            throw new Error(`Failed to get schedules: ${msg}`);
        }
    }

    async getSchedule(
        idOrName: string,
        accountId?: string,
        tenantId?: string
    ): Promise<UISchedule | null> {
        try {
            const effectiveTenantId = tenantId || 'org-default';
            const isUUID = idOrName.startsWith('sched-');

            if (isUUID) {
                const where: Record<string, unknown> = {
                    tenantId: effectiveTenantId,
                    scheduleId: idOrName,
                };
                if (accountId) where.accountId = accountId;

                const record = await getPrismaClient().schedule.findFirst({ where });
                if (record) return this.transformToUISchedule(record);
                return null;
            }

            // Name-based lookup
            const where: Record<string, unknown> = {
                tenantId: effectiveTenantId,
                name: idOrName,
            };
            if (accountId) where.accountId = accountId;

            const record = await getPrismaClient().schedule.findFirst({ where });
            if (!record) return null;
            return this.transformToUISchedule(record);
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[SchedulePostgresRepository] Error in getSchedule:', error);
            throw new Error(`Failed to get schedule: ${msg}`);
        }
    }

    async createSchedule(
        schedule: Omit<UISchedule, 'id'>,
        tenantId: string
    ): Promise<UISchedule> {
        try {
            const accountId = schedule.accounts?.[0];
            if (!accountId) {
                throw new Error('accountId is required to create a schedule');
            }

            const scheduleId = `sched-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

            const record = await getPrismaClient().schedule.create({
                data: {
                    tenantId,
                    scheduleId,
                    accountId,
                    name: schedule.name,
                    description: schedule.description,
                    starttime: schedule.starttime,
                    endtime: schedule.endtime,
                    timezone: schedule.timezone || 'UTC',
                    days: schedule.days || [],
                    active: schedule.active ?? true,
                    resources: (schedule.resources as object) || [],
                    createdBy: schedule.createdBy || 'system',
                    updatedBy: schedule.updatedBy || 'system',
                },
            });

            return this.transformToUISchedule(record);
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[SchedulePostgresRepository] Error in createSchedule:', error);
            throw new Error(`Failed to create schedule: ${msg}`);
        }
    }

    async updateSchedule(
        scheduleId: string,
        updates: Partial<UISchedule>,
        tenantId: string,
        _accountId?: string
    ): Promise<UISchedule> {
        try {
            const record = await getPrismaClient().schedule.update({
                where: {
                    tenantId_scheduleId: { tenantId, scheduleId },
                },
                data: {
                    ...(updates.name !== undefined && { name: updates.name }),
                    ...(updates.description !== undefined && { description: updates.description }),
                    ...(updates.starttime !== undefined && { starttime: updates.starttime }),
                    ...(updates.endtime !== undefined && { endtime: updates.endtime }),
                    ...(updates.timezone !== undefined && { timezone: updates.timezone }),
                    ...(updates.days !== undefined && { days: updates.days }),
                    ...(updates.active !== undefined && { active: updates.active }),
                    ...(updates.resources !== undefined && {
                        resources: (updates.resources as object) || [],
                    }),
                    ...(updates.updatedBy !== undefined && { updatedBy: updates.updatedBy }),
                },
            });

            return this.transformToUISchedule(record);
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[SchedulePostgresRepository] Error in updateSchedule:', error);
            throw new Error(`Failed to update schedule: ${msg}`);
        }
    }

    async deleteSchedule(scheduleId: string, tenantId: string, _accountId?: string): Promise<void> {
        try {
            await getPrismaClient().schedule.deleteMany({
                where: { tenantId, scheduleId },
            });
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[SchedulePostgresRepository] Error in deleteSchedule:', error);
            throw new Error(`Failed to delete schedule: ${msg}`);
        }
    }

    private transformToUISchedule(record: {
        id: string;
        tenantId: string;
        scheduleId: string;
        accountId: string;
        name: string;
        description: string | null;
        starttime: string;
        endtime: string;
        timezone: string;
        days: string[];
        active: boolean;
        resources: unknown;
        createdAt: Date;
        updatedAt: Date;
        createdBy: string;
        updatedBy: string;
    }): UISchedule {
        const resources = (record.resources as Array<{ type: string }>) || [];

        return {
            id: record.scheduleId,
            name: record.name,
            starttime: record.starttime,
            endtime: record.endtime,
            timezone: record.timezone,
            active: record.active,
            days: record.days,
            accounts: [record.accountId],
            resourceTypes: resources.map((r) => r.type).filter(Boolean),
            description: record.description ?? '',
            createdAt: record.createdAt.toISOString(),
            updatedAt: record.updatedAt.toISOString(),
            createdBy: record.createdBy,
            updatedBy: record.updatedBy,
            resources: record.resources as UISchedule['resources'],
            executionCount: 0,
            successRate: 100,
            estimatedSavings: 0,
        };
    }
}
