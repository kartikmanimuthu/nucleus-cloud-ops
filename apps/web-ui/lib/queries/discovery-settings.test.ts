// @vitest-environment jsdom
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

import { useDiscoverySettings, useSaveDiscoverySettings } from './discovery-settings';

function createWrapper() {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client: queryClient }, children);
    return { queryClient, wrapper };
}

const jsonRes = (body: unknown, opts: { ok?: boolean } = {}) => ({
    ok: opts.ok ?? true,
    json: () => Promise.resolve(body),
});
const discoverySettingsKey = ['settings', 'discovery'] as const;

describe('discovery-settings queries', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => vi.unstubAllGlobals());

    describe('useDiscoverySettings', () => {
        it('returns period/lastRunAt/nextEligibleAt', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: { period: 'weekly', lastRunAt: '2026-08-01', nextEligibleAt: '2026-08-08' } }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useDiscoverySettings(), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/settings/discovery');
            expect(result.current.data).toEqual({ period: 'weekly', lastRunAt: '2026-08-01', nextEligibleAt: '2026-08-08' });
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useDiscoverySettings(), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to load discovery settings');
        });
    });

    describe('useSaveDiscoverySettings', () => {
        it('PUTs the period and invalidates the settings key on success', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true }));
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useSaveDiscoverySettings(), { wrapper });
            result.current.mutate('monthly');
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/settings/discovery', expect.objectContaining({
                method: 'PUT', body: JSON.stringify({ period: 'monthly' }),
            }));
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: discoverySettingsKey });
        });

        it('throws with a fallback message on failure regardless of HTTP status', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSaveDiscoverySettings(), { wrapper });
            result.current.mutate('daily');
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to save');
        });
    });
});
