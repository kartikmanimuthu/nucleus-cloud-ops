'use client';

/**
 * TanStack Query hooks for the Scaling Audit domain (SA-001).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queries/query-keys';
import type {
    ScalingEvent,
    ScalingResourceSummary,
    ScalingAuditSummary,
    ScalingAuditFacets,
    ScalingAuditRun,
    WatermarkGap,
} from '@/lib/db/repositories/scaling-audit/interface';

export interface ScalingAuditEventFilters {
    page: number;
    limit: number;
    search?: string;
    accountId?: string;
    region?: string;
    scope?: string;
    source?: string;
    scalingType?: string;
    /** Ignored when `scalingType` is set — see ScalingEventFilters. */
    excludeScalingTypes?: string[];
    /** 'capacity_changes' (default) or 'all' — see ScalingEffectFilter. */
    effect?: 'capacity_changes' | 'all';
    dateFrom?: string;
    dateTo?: string;
}

interface EventsResult {
    data: ScalingEvent[];
    total: number;
}

export function useScalingEvents(filters: ScalingAuditEventFilters, options?: { enabled?: boolean }) {
    return useQuery({
        queryKey: queryKeys.scalingAudit.events(filters),
        queryFn: async (): Promise<EventsResult> => {
            const params = new URLSearchParams({ page: String(filters.page), limit: String(filters.limit) });
            if (filters.search?.trim()) params.set('search', filters.search.trim());
            if (filters.accountId) params.set('account', filters.accountId);
            if (filters.region) params.set('region', filters.region);
            if (filters.scope) params.set('scope', filters.scope);
            if (filters.source) params.set('source', filters.source);
            if (filters.scalingType) params.set('scalingType', filters.scalingType);
            else if (filters.excludeScalingTypes?.length) params.set('excludeScalingTypes', filters.excludeScalingTypes.join(','));
            if (filters.effect) params.set('effect', filters.effect);
            if (filters.dateFrom) params.set('dateFrom', filters.dateFrom);
            if (filters.dateTo) params.set('dateTo', filters.dateTo);

            const res = await fetch(`/api/scaling-audit/events?${params.toString()}`);
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json.error || 'Failed to load scaling events');
            return { data: json.data, total: json.meta?.total ?? 0 };
        },
        enabled: options?.enabled ?? true,
        placeholderData: (prev) => prev,
    });
}

/**
 * Resource-centric list — the default view. Takes the same filters as
 * useScalingEvents so the counts shown always match the drill-through.
 */
export function useScalingResources(filters: Omit<ScalingAuditEventFilters, never>, options?: { enabled?: boolean }) {
    return useQuery({
        queryKey: queryKeys.scalingAudit.resources(filters),
        queryFn: async (): Promise<{ data: ScalingResourceSummary[]; total: number }> => {
            const params = new URLSearchParams({ page: String(filters.page), limit: String(filters.limit) });
            if (filters.search?.trim()) params.set('search', filters.search.trim());
            if (filters.accountId) params.set('account', filters.accountId);
            if (filters.region) params.set('region', filters.region);
            if (filters.scope) params.set('scope', filters.scope);
            if (filters.source) params.set('source', filters.source);
            if (filters.scalingType) params.set('scalingType', filters.scalingType);
            if (filters.effect) params.set('effect', filters.effect);
            if (filters.dateFrom) params.set('dateFrom', filters.dateFrom);
            if (filters.dateTo) params.set('dateTo', filters.dateTo);

            const res = await fetch(`/api/scaling-audit/resources?${params.toString()}`);
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json.error || 'Failed to load resources');
            return { data: json.data, total: json.meta?.total ?? 0 };
        },
        enabled: options?.enabled ?? true,
        placeholderData: (prev) => prev,
    });
}

export function useScalingEvent(id: string | undefined) {
    return useQuery({
        queryKey: queryKeys.scalingAudit.detail(id ?? ''),
        enabled: !!id,
        queryFn: async (): Promise<ScalingEvent> => {
            const res = await fetch(`/api/scaling-audit/events/${id}`);
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json.error || 'Scaling event not found');
            return json.data as ScalingEvent;
        },
    });
}

export function useScalingAuditSummary() {
    return useQuery({
        queryKey: queryKeys.scalingAudit.summary(),
        queryFn: async (): Promise<(ScalingAuditSummary & { facets: ScalingAuditFacets }) | null> => {
            const res = await fetch('/api/scaling-audit/summary');
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json.error || 'Failed to load summary');
            return json.data;
        },
        placeholderData: (prev) => prev,
    });
}

export function useScalingAuditCoverage() {
    return useQuery({
        queryKey: queryKeys.scalingAudit.coverage(),
        queryFn: async (): Promise<WatermarkGap[]> => {
            const res = await fetch('/api/scaling-audit/coverage');
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json.error || 'Failed to load coverage');
            return json.data;
        },
    });
}

export function useScalingAuditRuns(page = 1, limit = 20) {
    return useQuery({
        queryKey: queryKeys.scalingAudit.runs({ page, limit }),
        queryFn: async (): Promise<{ data: ScalingAuditRun[]; total: number }> => {
            const res = await fetch(`/api/scaling-audit/runs?page=${page}&limit=${limit}`);
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json.error || 'Failed to load runs');
            return { data: json.data, total: json.meta?.total ?? 0 };
        },
        placeholderData: (prev) => prev,
    });
}

/** Kick off an on-demand scaling-audit scan; invalidates the domain cache on success. */
export function useRunScalingAuditScan() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (): Promise<{ alreadyRunning?: boolean }> => {
            const res = await fetch('/api/scaling-audit/runs', { method: 'POST' });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json.error || 'Failed to start scan');
            return json;
        },
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: queryKeys.scalingAudit.all });
        },
    });
}

/** Export current-filter events as Excel/PDF and trigger a browser download. */
export function useExportScalingAudit() {
    return useMutation({
        mutationFn: async (params: { format: 'xlsx' | 'pdf' } & Omit<ScalingAuditEventFilters, 'page' | 'limit'>): Promise<void> => {
            const { format, ...filters } = params;
            const res = await fetch('/api/scaling-audit/export', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    format,
                    accountId: filters.accountId,
                    region: filters.region,
                    scope: filters.scope,
                    source: filters.source,
                    scalingType: filters.scalingType,
                    searchTerm: filters.search,
                    // Carried through so the exported file matches the on-screen
                    // row set, and its coverage statement declares which it is.
                    effect: filters.effect,
                    dateFrom: filters.dateFrom,
                    dateTo: filters.dateTo,
                }),
            });
            if (!res.ok) {
                const json = await res.json().catch(() => ({}));
                throw new Error(json.error || 'Failed to export scaling audit records');
            }
            const blob = await res.blob();
            const disposition = res.headers.get('Content-Disposition') ?? '';
            const match = disposition.match(/filename="([^"]+)"/);
            const filename = match?.[1] ?? `scaling-audit-export.${format}`;
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        },
    });
}
