'use client';

/**
 * TanStack Query hooks for the Schedules domain.
 * Mirrors lib/queries/accounts.ts — wraps ClientScheduleService with caching
 * + automatic invalidation on mutation.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClientScheduleService } from '@/lib/client-schedule-service';
import { queryKeys } from '@/lib/queries/query-keys';
import type { Schedule, UISchedule } from '@/lib/types';

export interface ScheduleFilters {
    statusFilter?: string;
    resourceFilter?: string;
    searchTerm?: string;
    page?: number;
    limit?: number;
}

interface SchedulesListData {
    schedules: UISchedule[];
    total: number;
}

/** List schedules with optional filters. Returns { schedules, total }. */
export function useSchedules(
    filters?: ScheduleFilters,
    options?: { initialData?: SchedulesListData },
) {
    return useQuery({
        queryKey: queryKeys.schedules.list(filters),
        queryFn: () => ClientScheduleService.getSchedules(filters),
        placeholderData: (prev) => prev,
        initialData: options?.initialData,
    });
}

/** One execution-history row as returned by GET /api/schedules/[id]/history. */
export interface ScheduleExecutionRow {
    executionId: string;
    executionTime: string;
    status: string;
    duration?: number;
    resourcesStarted: number;
    resourcesStopped: number;
    resourcesFailed: number;
    errorMessage?: string;
}

interface ExecutionsPage {
    executions: ScheduleExecutionRow[];
    total: number;
}

/**
 * Paginated execution history for a single schedule. Server-side paged via
 * ?page & ?limit. Disabled until a scheduleId is provided.
 */
export function useScheduleExecutions(
    scheduleId: string | undefined,
    page: number,
    limit: number,
) {
    return useQuery<ExecutionsPage>({
        queryKey: queryKeys.schedules.executions(scheduleId ?? '', { page, limit }),
        queryFn: async () => {
            const params = new URLSearchParams({ page: String(page), limit: String(limit) });
            const res = await fetch(
                `/api/schedules/${encodeURIComponent(scheduleId as string)}/history?${params.toString()}`,
            );
            if (!res.ok) throw new Error('Failed to load execution history');
            const data = await res.json();
            return { executions: data.executions ?? [], total: data.total ?? 0 };
        },
        enabled: !!scheduleId,
        placeholderData: (prev) => prev,
    });
}

/** Fetch a single schedule by id. Disabled when no id is provided. */
export function useSchedule(id: string | undefined) {
    return useQuery({
        queryKey: queryKeys.schedules.detail(id ?? ''),
        queryFn: () => ClientScheduleService.getSchedule(id as string),
        enabled: !!id,
    });
}

export function useCreateSchedule() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: (schedule: Omit<Schedule, 'id' | 'type'>) =>
            ClientScheduleService.createSchedule(schedule),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: queryKeys.schedules.all });
        },
    });
}

export function useUpdateSchedule() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: ({
            scheduleId,
            updates,
        }: {
            scheduleId: string;
            updates: Partial<Omit<Schedule, 'name' | 'type'>>;
        }) => ClientScheduleService.updateSchedule(scheduleId, updates),
        onSuccess: (_res, { scheduleId }) => {
            qc.invalidateQueries({ queryKey: queryKeys.schedules.lists() });
            qc.invalidateQueries({ queryKey: queryKeys.schedules.detail(scheduleId) });
        },
    });
}

export function useDeleteSchedule() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: (id: string) => ClientScheduleService.deleteSchedule(id),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: queryKeys.schedules.all });
        },
    });
}

export function useToggleSchedule() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: (id: string) => ClientScheduleService.toggleScheduleStatus(id),
        onSuccess: (_res, id) => {
            qc.invalidateQueries({ queryKey: queryKeys.schedules.lists() });
            qc.invalidateQueries({ queryKey: queryKeys.schedules.detail(id) });
        },
    });
}

export type { UISchedule };
