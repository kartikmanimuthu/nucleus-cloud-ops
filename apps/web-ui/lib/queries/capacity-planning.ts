'use client';

/**
 * TanStack Query hooks for the Capacity Planning domain (SA-004).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queries/query-keys';
import type {
    CapacityUtilizationSummaryRow,
    CapacityBreachInstance,
    CapacityPlanningRun,
    CapacityResourceDetail,
    CapacityResourceType,
} from '@/lib/db/repositories/capacity-planning/interface';

export interface CapacityPlanningFilters {
    page: number;
    limit: number;
    search?: string;
    accountId?: string;
    region?: string;
    resourceType?: CapacityResourceType;
    dateFrom?: string;
    dateTo?: string;
    threshold?: number;
}

function toParams(filters: CapacityPlanningFilters): URLSearchParams {
    const params = new URLSearchParams({ page: String(filters.page), limit: String(filters.limit) });
    if (filters.search?.trim()) params.set('search', filters.search.trim());
    if (filters.accountId) params.set('account', filters.accountId);
    if (filters.region) params.set('region', filters.region);
    if (filters.resourceType) params.set('resourceType', filters.resourceType);
    if (filters.dateFrom) params.set('dateFrom', filters.dateFrom);
    if (filters.dateTo) params.set('dateTo', filters.dateTo);
    if (filters.threshold != null) params.set('threshold', String(filters.threshold));
    return params;
}

export function useCapacityUtilizationSummary(filters: CapacityPlanningFilters, options?: { enabled?: boolean }) {
    return useQuery({
        queryKey: queryKeys.capacityPlanning.summary(filters),
        queryFn: async (): Promise<{ data: CapacityUtilizationSummaryRow[]; total: number }> => {
            const res = await fetch(`/api/capacity-planning/summary?${toParams(filters).toString()}`);
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json.error || 'Failed to load capacity utilization summary');
            return { data: json.data, total: json.meta?.total ?? 0 };
        },
        enabled: options?.enabled ?? true,
        placeholderData: (prev) => prev,
    });
}

export function useCapacityBreachInstances(filters: CapacityPlanningFilters) {
    return useQuery({
        queryKey: queryKeys.capacityPlanning.breaches(filters),
        queryFn: async (): Promise<{ data: CapacityBreachInstance[]; total: number }> => {
            const res = await fetch(`/api/capacity-planning/breaches?${toParams(filters).toString()}`);
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json.error || 'Failed to load breach instances');
            return { data: json.data, total: json.meta?.total ?? 0 };
        },
        placeholderData: (prev) => prev,
    });
}

/** One resource's installed/utilised/breach detail — Scale Sentinel's resource
 *  detail page "Scaling & Capacity" tab. Enabled only for ecs/asg, since that's
 *  all Capacity Planning tracks today. */
export function useCapacityResourceDetail(
    resourceId: string,
    filters: { resourceType?: CapacityResourceType; accountId?: string; region?: string },
    options?: { enabled?: boolean }
) {
    const params = new URLSearchParams();
    if (filters.resourceType) params.set('resourceType', filters.resourceType);
    if (filters.accountId) params.set('account', filters.accountId);
    if (filters.region) params.set('region', filters.region);

    return useQuery({
        queryKey: queryKeys.capacityPlanning.resource(resourceId, filters),
        queryFn: async (): Promise<CapacityResourceDetail | null> => {
            const res = await fetch(`/api/capacity-planning/resources/${encodeURIComponent(resourceId)}?${params.toString()}`);
            if (res.status === 404) return null;
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json.error || 'Failed to load capacity resource detail');
            return json.data;
        },
        enabled: (options?.enabled ?? true) && !!resourceId,
    });
}

export function useCapacityPlanningRuns(page = 1, limit = 20) {
    return useQuery({
        queryKey: queryKeys.capacityPlanning.runs({ page, limit }),
        queryFn: async (): Promise<{ data: CapacityPlanningRun[]; total: number }> => {
            const res = await fetch(`/api/capacity-planning/runs?page=${page}&limit=${limit}`);
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json.error || 'Failed to load runs');
            return { data: json.data, total: json.meta?.total ?? 0 };
        },
        placeholderData: (prev) => prev,
    });
}

/** Kick off an on-demand capacity-planning scan; invalidates the domain cache on success. */
export function useRunCapacityPlanningScan() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (): Promise<{ alreadyRunning?: boolean }> => {
            const res = await fetch('/api/capacity-planning/runs', { method: 'POST' });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json.error || 'Failed to start scan');
            return json;
        },
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: queryKeys.capacityPlanning.all });
        },
    });
}
