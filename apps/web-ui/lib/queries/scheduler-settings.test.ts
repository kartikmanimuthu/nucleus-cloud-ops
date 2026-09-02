// @vitest-environment jsdom
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

import { useSchedulerSettings, useSaveSchedulerSettings } from './scheduler-settings';

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
const schedulerSettingsKey = ['scheduler', 'settings'] as const;

describe('scheduler-settings queries', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => vi.unstubAllGlobals());

    describe('useSchedulerSettings', () => {
        it('returns the configured interval', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: { intervalMinutes: 15 } }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSchedulerSettings(), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(result.current.data).toEqual({ intervalMinutes: 15 });
        });

        it('defaults intervalMinutes to 60 when absent', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: {} }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSchedulerSettings(), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(result.current.data).toEqual({ intervalMinutes: 60 });
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSchedulerSettings(), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to load scheduler settings');
        });
    });

    describe('useSaveSchedulerSettings', () => {
        it('PUTs { scheduleInterval } and invalidates the settings key on success', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true }));
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useSaveSchedulerSettings(), { wrapper });
            result.current.mutate(30);
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/scheduler/settings', expect.objectContaining({
                method: 'PUT', body: JSON.stringify({ scheduleInterval: 30 }),
            }));
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: schedulerSettingsKey });
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSaveSchedulerSettings(), { wrapper });
            result.current.mutate(30);
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to save');
        });
    });
});
