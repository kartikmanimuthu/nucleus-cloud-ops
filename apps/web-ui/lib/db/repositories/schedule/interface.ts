/**
 * IScheduleRepository
 *
 * Contract for schedule persistence.
 * Implemented by ScheduleDynamoRepository and SchedulePostgresRepository.
 * The feature flag USE_PG_SCHEDULES controls which implementation is active.
 */

import type { PrismaRowFilter } from '@/lib/db/pg-config';
import type { UISchedule } from '@/lib/types';

export interface ScheduleFilters {
    tenantId: string;
    searchTerm?: string;
    statusFilter?: string;   // 'active' | 'inactive' | 'all'
    resourceFilter?: string; // resource type filter
    accountId?: string;
    page?: number;
    limit?: number;
    /**
     * Gate 3 (RBAC row filtering): a Prisma `where` fragment restricting the
     * result to the rows the caller may read. Built by
     * getReadRowFilter() in lib/rbac/row-filter.ts and INTERSECTED with the
     * query below via andWhere() — never merged over it.
     */
    rowFilter?: PrismaRowFilter | null;
}

export interface SchedulePage {
    schedules: UISchedule[];
    total: number;
}

export interface IScheduleRepository {
    getSchedules(filters: ScheduleFilters): Promise<SchedulePage>;
    getSchedule(idOrName: string, accountId?: string, tenantId?: string): Promise<UISchedule | null>;
    createSchedule(schedule: Omit<UISchedule, 'id'>, tenantId: string): Promise<UISchedule>;
    updateSchedule(scheduleId: string, updates: Partial<UISchedule>, tenantId: string, accountId?: string): Promise<UISchedule>;
    deleteSchedule(scheduleId: string, tenantId: string, accountId?: string): Promise<void>;
}
