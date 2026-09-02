// @vitest-environment jsdom
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

import { useAgentOpsDefaults, useSaveAgentOpsDefaults } from './agent-ops-settings';

function createWrapper() {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client: queryClient }, children);
    return { queryClient, wrapper };
}

describe('agent-ops-settings queries', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => vi.unstubAllGlobals());

    describe('useAgentOpsDefaults', () => {
        it('defaults configured=false, defaultModel="", maxIterations=150 and defaultMode="plan" when absent', async () => {
            (fetch as Mock).mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useAgentOpsDefaults(), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/agent-ops/settings/defaults');
            expect(result.current.data).toEqual({ configured: false, defaultModel: '', maxIterations: 150, defaultMode: 'plan' });
        });

        it('returns the configured values when present', async () => {
            (fetch as Mock).mockResolvedValue({ ok: true, json: () => Promise.resolve({ configured: true, defaultModel: 'claude-sonnet-5', maxIterations: 50 }) });
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useAgentOpsDefaults(), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            // No defaultMode in the payload (a pre-selector config) still normalises
            // to the hook's FALLBACK_DEFAULT_MODE rather than undefined.
            expect(result.current.data).toEqual({ configured: true, defaultModel: 'claude-sonnet-5', maxIterations: 50, defaultMode: 'plan' });
        });

        it('throws with a fallback message on failure, tolerating an unparsable body', async () => {
            (fetch as Mock).mockResolvedValue({ ok: false, json: () => Promise.reject(new Error('bad json')) });
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useAgentOpsDefaults(), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to load Agent Ops defaults');
        });
    });

    describe('useSaveAgentOpsDefaults', () => {
        it('PUTs the body and invalidates the defaults key on success', async () => {
            (fetch as Mock).mockResolvedValue({ ok: true, json: () => Promise.resolve({ configured: true, defaultModel: 'm', maxIterations: 10 }) });
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useSaveAgentOpsDefaults(), { wrapper });
            result.current.mutate({ defaultModel: 'm', maxIterations: 10 });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/agent-ops/settings/defaults', expect.objectContaining({
                method: 'PUT', body: JSON.stringify({ defaultModel: 'm', maxIterations: 10 }),
            }));
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['agent-ops', 'defaults'] });
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue({ ok: false, json: () => Promise.resolve({}) });
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSaveAgentOpsDefaults(), { wrapper });
            result.current.mutate({ defaultModel: 'm', maxIterations: 10 });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to save Agent Ops defaults');
        });
    });
});
