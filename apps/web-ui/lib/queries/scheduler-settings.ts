'use client';

/**
 * TanStack Query hooks for the org scheduler frequency setting.
 * Fetch inlined; save mutation invalidates the cache on success.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

const schedulerSettingsKey = ['scheduler', 'settings'] as const;

export function useSchedulerSettings() {
    return useQuery({
        queryKey: schedulerSettingsKey,
        queryFn: async (): Promise<{ intervalMinutes: number }> => {
            const res = await fetch('/api/scheduler/settings');
            const json = await res.json();
            if (!res.ok || !json.success) {
                throw new Error(json.error || 'Failed to load scheduler settings');
            }
            return { intervalMinutes: json.data.intervalMinutes ?? 60 };
        },
    });
}

export function useSaveSchedulerSettings() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (intervalMinutes: number) => {
            const res = await fetch('/api/scheduler/settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ scheduleInterval: intervalMinutes }),
            });
            const json = await res.json();
            if (!json.success) throw new Error(json.error || 'Failed to save');
            return json;
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: schedulerSettingsKey }),
    });
}
