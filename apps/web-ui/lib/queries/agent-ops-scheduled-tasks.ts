'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { queryKeys } from '@/lib/queries/query-keys';
import type { AgentOpsRun, ScheduledTask } from '@/lib/agent-ops/types';
import type { TaskListQuery, TaskListStats } from '@/lib/db/repositories/scheduled-task/interface';

export interface TaskListFilters {
    page?: number;
    limit?: number;
    sortBy?: TaskListQuery['sortBy'];
    sortDir?: 'asc' | 'desc';
}

export interface TaskListResponse {
    tasks: ScheduledTask[];
    total: number;
    stats: TaskListStats;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data as T;
}

export function useScheduledTasks(filters: TaskListFilters = {}) {
    return useQuery({
        queryKey: queryKeys.agentOps.scheduledTasks.list(filters),
        queryFn: async () => {
            const params = new URLSearchParams();
            params.set('page', String(filters.page ?? 1));
            params.set('limit', String(filters.limit ?? 25));
            if (filters.sortBy) {
                params.set('sortBy', filters.sortBy);
                params.set('sortDir', filters.sortDir ?? 'asc');
            }
            const data = await fetchJson<{
                success: boolean;
                data?: ScheduledTask[];
                total?: number;
                stats?: TaskListStats;
                error?: string;
            }>(`/api/agent-ops/scheduled-tasks?${params}`);
            if (!data.success) throw new Error(data.error || 'Failed to load scheduled tasks');
            return {
                tasks: data.data ?? [],
                total: data.total ?? 0,
                stats: data.stats ?? { active: 0, paused: 0, totalRuns: 0 },
            };
        },
    });
}

export interface RunHistoryPage {
    runs: AgentOpsRun[];
    total: number;
}

/**
 * Server-paginated run history for one scheduled task. `total` is the count of
 * that task's runs (filtered in SQL), so the pagination bar reflects reality.
 * keepPreviousData avoids the list flashing empty while a page is fetched.
 */
export function useScheduledTaskRuns(
    taskId: string,
    filters: { page?: number; limit?: number } = {}
) {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 25;
    return useQuery({
        queryKey: queryKeys.agentOps.scheduledTasks.runs(taskId, { page, limit }),
        enabled: Boolean(taskId),
        placeholderData: (prev) => prev,
        queryFn: async (): Promise<RunHistoryPage> => {
            const params = new URLSearchParams({ page: String(page), limit: String(limit) });
            const data = await fetchJson<{ runs?: AgentOpsRun[]; total?: number; error?: string }>(
                `/api/agent-ops/scheduled-tasks/${taskId}/runs?${params}`
            );
            return { runs: data.runs ?? [], total: data.total ?? 0 };
        },
    });
}

export function useCreateScheduledTask() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (body: Record<string, unknown>): Promise<ScheduledTask> => {
            const res = await fetch('/api/agent-ops/scheduled-tasks', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
            return data.task;
        },
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: queryKeys.agentOps.scheduledTasks.all });
        },
        onError: (err) => {
            toast.error('Failed to save scheduled task', { description: (err as Error).message });
        },
    });
}

export interface ScheduledTaskDraft {
    name: string;
    prompt: string;
    suggestedCron: string;
    cadenceLabel: string;
}

export function useDistillScheduledTask() {
    return useMutation({
        mutationFn: async (transcript: string): Promise<ScheduledTaskDraft> => {
            const res = await fetch('/api/agent-ops/scheduled-tasks/distill', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ transcript }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) throw new Error(data.error || `Request failed (${res.status})`);
            return data.data as ScheduledTaskDraft;
        },
    });
}
