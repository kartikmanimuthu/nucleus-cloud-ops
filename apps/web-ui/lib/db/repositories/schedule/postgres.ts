/**
 * SchedulePostgresRepository
 *
 * PostgreSQL implementation of IScheduleRepository using Prisma ORM.
 * Reads/writes the `schedules` table (defined in libs/prisma/schema.prisma).
 *
 * Key improvement over DynamoDB path: getSchedules uses server-side WHERE/ILIKE/LIMIT/OFFSET
 * instead of fetching all records and filtering in memory.
 *
 * Multi-tenant safety: every query is scoped by tenantId — no cross-tenant data access.
 */
import { andWhere, getTenantClient } from '@/lib/db/pg-config';
import type { UISchedule } from '@/lib/types';
import type { IScheduleRepository, ScheduleFilters, SchedulePage } from './interface';

const DAY_ORDER: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function computeNextExecution(days: string[], starttime: string, timezone: string, active: boolean): string | undefined {
    if (!active || !days.length || !starttime) return undefined;
    const now = new Date();
    for (let offset = 0; offset < 7; offset++) {
        const candidate = new Date(now.getTime() + offset * 86400000);
        const dayName = DAY_NAMES[candidate.getDay()];
        if (!days.includes(dayName)) continue;
        const [hh, mm, ss] = starttime.split(':').map(Number);
        const exec = new Date(candidate);
        exec.setHours(hh, mm, ss || 0, 0);
        if (exec > now) return exec.toISOString();
    }
    return undefined;
}

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
                rowFilter,
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

            // Gate 3: intersect the caller's readable rows. andWhere() nests
            // under AND so the `OR` search clause above survives, and tenantId is
            // still injected on top by the tenant client.
            const scoped = andWhere(where, rowFilter);

            const [total, rows] = await Promise.all([
                getTenantClient(tenantId).schedule.count({ where: scoped }),
                getTenantClient(tenantId).schedule.findMany({
                    where: scoped,
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

                const record = await getTenantClient(effectiveTenantId).schedule.findFirst({ where });
                if (record) return this.transformToUISchedule(record);
                return null;
            }

            // Name-based lookup
            const where: Record<string, unknown> = {
                tenantId: effectiveTenantId,
                name: idOrName,
            };
            if (accountId) where.accountId = accountId;

            const record = await getTenantClient(effectiveTenantId).schedule.findFirst({ where });
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

            const record = await getTenantClient(tenantId).schedule.create({
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
            const record = await getTenantClient(tenantId).schedule.update({
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
            await getTenantClient(tenantId).schedule.deleteMany({
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
            days: [...record.days].sort((a, b) => (DAY_ORDER[a] ?? 99) - (DAY_ORDER[b] ?? 99)),
            accounts: [record.accountId],
            resourceTypes: [...new Set(resources.map((r) => r.type).filter(Boolean))],
            description: record.description ?? '',
            createdAt: record.createdAt.toISOString(),
            updatedAt: record.updatedAt.toISOString(),
            createdBy: record.createdBy,
            updatedBy: record.updatedBy,
            resources: record.resources as UISchedule['resources'],
            executionCount: 0,
            successRate: 100,
            estimatedSavings: 0,
            nextExecution: computeNextExecution(record.days, record.starttime, record.timezone, record.active),
        };
    }
}
