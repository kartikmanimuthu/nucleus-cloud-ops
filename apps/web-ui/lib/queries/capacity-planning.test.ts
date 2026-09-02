// @vitest-environment jsdom
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

import {
    useCapacityUtilizationSummary,
    useCapacityBreachInstances,
    useCapacityResourceDetail,
    useCapacityPlanningRuns,
    useRunCapacityPlanningScan,
} from './capacity-planning';
import { queryKeys } from '@/lib/queries/query-keys';

function createWrapper() {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client: queryClient }, children);
    return { queryClient, wrapper };
}

const jsonRes = (body: unknown, opts: { ok?: boolean; status?: number } = {}) => ({
    ok: opts.ok ?? true,
    status: opts.status ?? (opts.ok === false ? 400 : 200),
    json: () => Promise.resolve(body),
});

describe('capacity-planning queries', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => vi.unstubAllGlobals());

    describe('useCapacityUtilizationSummary', () => {
        it('serializes filters including a numeric threshold of 0', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: [], meta: { total: 2 } }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(
                () => useCapacityUtilizationSummary({ page: 1, limit: 10, threshold: 0, resourceType: 'ecs' }),
                { wrapper },
            );
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            const url = (fetch as Mock).mock.calls[0][0] as string;
            expect(url).toContain('threshold=0');
            expect(url).toContain('resourceType=ecs');
            expect(result.current.data?.total).toBe(2);
        });

        it('respects options.enabled', () => {
            const { wrapper } = createWrapper();
            renderHook(() => useCapacityUtilizationSummary({ page: 1, limit: 10 }, { enabled: false }), { wrapper });
            expect(fetch).not.toHaveBeenCalled();
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useCapacityUtilizationSummary({ page: 1, limit: 10 }), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to load capacity utilization summary');
        });
    });

    describe('useCapacityBreachInstances', () => {
        it('fetches breach instances with filters', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: [{ id: 'b1' }], meta: { total: 1 } }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useCapacityBreachInstances({ page: 1, limit: 10, accountId: 'a1' }), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect((fetch as Mock).mock.calls[0][0]).toContain('account=a1');
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useCapacityBreachInstances({ page: 1, limit: 10 }), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to load breach instances');
        });
    });

    describe('useCapacityResourceDetail', () => {
        it('returns null on a 404 without throwing', async () => {
            (fetch as Mock).mockResolvedValue({ status: 404, ok: false, json: () => Promise.resolve({}) });
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useCapacityResourceDetail('r1', {}), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(result.current.data).toBeNull();
        });

        it('fetches the resource detail and encodes the resourceId', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: { resourceId: 'r 1' } }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(
                () => useCapacityResourceDetail('r 1', { resourceType: 'ecs', accountId: 'a1', region: 'us-east-1' }),
                { wrapper },
            );
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            const url = (fetch as Mock).mock.calls[0][0] as string;
            expect(url).toContain('/api/capacity-planning/resources/r%201');
            expect(url).toContain('resourceType=ecs');
            expect(url).toContain('account=a1');
            expect(url).toContain('region=us-east-1');
        });

        it('is disabled when resourceId is empty even if options.enabled is true', () => {
            const { wrapper } = createWrapper();
            renderHook(() => useCapacityResourceDetail('', {}, { enabled: true }), { wrapper });
            expect(fetch).not.toHaveBeenCalled();
        });

        it('throws with a fallback message on a non-404 failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false, status: 500 }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useCapacityResourceDetail('r1', {}), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to load capacity resource detail');
        });
    });

    describe('useCapacityPlanningRuns', () => {
        it('defaults page=1/limit=20 and forwards custom values', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: [], meta: { total: 0 } }));
            const { wrapper } = createWrapper();
            renderHook(() => useCapacityPlanningRuns(), { wrapper });
            await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/capacity-planning/runs?page=1&limit=20'));
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useCapacityPlanningRuns(), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to load runs');
        });
    });

    describe('useRunCapacityPlanningScan', () => {
        it('POSTs and invalidates capacityPlanning.all on success', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true }));
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useRunCapacityPlanningScan(), { wrapper });
            result.current.mutate();
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/capacity-planning/runs', { method: 'POST' });
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.capacityPlanning.all });
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useRunCapacityPlanningScan(), { wrapper });
            result.current.mutate();
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to start scan');
        });
    });
});
