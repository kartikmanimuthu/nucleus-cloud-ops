'use client';

/**
 * TanStack Query hooks for the org discovery scan frequency setting.
 * Save invalidates the cache so the derived lastRun/nextEligible timestamps
 * refresh automatically.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export type DiscoveryPeriod = 'daily' | 'weekly' | 'monthly';

export interface DiscoverySettingsData {
    period: DiscoveryPeriod;
    lastRunAt: string | null;
    nextEligibleAt: string | null;
}

const discoverySettingsKey = ['settings', 'discovery'] as const;

export function useDiscoverySettings() {
    return useQuery({
        queryKey: discoverySettingsKey,
        queryFn: async (): Promise<DiscoverySettingsData> => {
            const res = await fetch('/api/settings/discovery');
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json.error || 'Failed to load discovery settings');
            }
            return {
                period: json.data.period,
                lastRunAt: json.data.lastRunAt,
                nextEligibleAt: json.data.nextEligibleAt,
            };
        },
    });
}

export function useSaveDiscoverySettings() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (period: DiscoveryPeriod) => {
            const res = await fetch('/api/settings/discovery', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ period }),
            });
            const json = await res.json();
            if (!json.success) throw new Error(json.error || 'Failed to save');
            return json;
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: discoverySettingsKey }),
    });
}
