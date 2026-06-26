'use client';

/**
 * TanStack Query hooks for the Right Sizing domain. No client service class
 * exists, so the API fetches are inlined in the query/mutation fns.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queries/query-keys';
import type {
    RightSizingRecommendation,
    RightSizingSummary,
} from '@/lib/db/repositories/right-sizing/interface';

export interface RightSizingFilters {
    page: number;
    limit: number;
    sort: string;
    search?: string;
    resourceType?: string;
    finding?: string;
    status?: string;
}

interface RecommendationsResult {
    data: RightSizingRecommendation[];
    total: number;
}

export function useRightSizingRecommendations(filters: RightSizingFilters) {
    return useQuery({
        queryKey: queryKeys.rightSizing.recommendations(filters),
        queryFn: async (): Promise<RecommendationsResult> => {
            const params = new URLSearchParams({
                page: String(filters.page),
                limit: String(filters.limit),
                sort: filters.sort,
            });
            if (filters.search?.trim()) params.set('search', filters.search.trim());
            if (filters.resourceType) params.set('resourceType', filters.resourceType);
            if (filters.finding) params.set('finding', filters.finding);
            if (filters.status) params.set('status', filters.status);

            const res = await fetch(`/api/right-sizing/recommendations?${params.toString()}`);
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json.error || 'Failed to load recommendations');
            }
            return { data: json.data, total: json.meta?.total ?? 0 };
        },
        placeholderData: (prev) => prev,
    });
}

export function useRightSizingSummary() {
    return useQuery({
        queryKey: queryKeys.rightSizing.summary(),
        queryFn: async (): Promise<RightSizingSummary | null> => {
            const res = await fetch('/api/right-sizing/summary');
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json.error || 'Failed to load summary');
            }
            return json.data;
        },
        placeholderData: (prev) => prev,
    });
}

/** Kick off a right-sizing scan; invalidates the domain cache on success. */
export function useRunRightSizingScan() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (): Promise<{ alreadyRunning?: boolean }> => {
            const res = await fetch('/api/right-sizing/runs', { method: 'POST' });
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json.error || 'Failed to start scan');
            }
            return json;
        },
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: queryKeys.rightSizing.all });
        },
    });
}
