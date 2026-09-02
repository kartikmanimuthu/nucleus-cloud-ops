// @vitest-environment jsdom
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { toast } from 'sonner';
import {
    useAgentOpsRuns,
    useAgentOpsRunDetail,
    useCancelRun,
    useApproveRun,
    useResumeRun,
} from './agent-ops';
import { queryKeys } from './query-keys';

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

describe('agent-ops queries', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
        vi.mocked(toast.error).mockClear();
    });
    afterEach(() => vi.unstubAllGlobals());

    describe('useAgentOpsRuns', () => {
        it('omits source/status when "all", and defaults sortDir to desc', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: [], total: 0, stats: { total: 0, inProgress: 0, completed: 0, failed: 0 } }));
            const { wrapper } = createWrapper();
            renderHook(() => useAgentOpsRuns({ source: 'all', status: 'all', sortBy: 'createdAt' }), { wrapper });
            await waitFor(() => {
                const url = (fetch as Mock).mock.calls[0][0] as string;
                expect(url).not.toContain('source=');
                expect(url).not.toContain('status=');
                expect(url).toContain('sortBy=createdAt');
                expect(url).toContain('sortDir=desc');
            });
        });

        it('includes a real source/status filter', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: [] }));
            const { wrapper } = createWrapper();
            renderHook(() => useAgentOpsRuns({ source: 'slack', status: 'failed' }), { wrapper });
            await waitFor(() => {
                const url = (fetch as Mock).mock.calls[0][0] as string;
                expect(url).toContain('source=slack');
                expect(url).toContain('status=failed');
            });
        });

        it('defaults runs/total/stats when the body omits them', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useAgentOpsRuns(), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(result.current.data).toEqual({ runs: [], total: 0, stats: { total: 0, inProgress: 0, completed: 0, failed: 0 } });
        });

        it('throws with the server error when success is false', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false, error: 'bad query' }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useAgentOpsRuns(), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('bad query');
        });

        it('polls every 5s while any run is active, and every 30s once all are settled', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: [{ status: 'in_progress' }], total: 1 }));
            const { wrapper, queryClient } = createWrapper();
            const { result } = renderHook(() => useAgentOpsRuns(), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));

            const entry = queryClient.getQueryCache().find({ queryKey: queryKeys.agentOps.list({}) });
            const refetchInterval = entry?.options.refetchInterval as Function;

            expect(refetchInterval({ state: { data: { runs: [{ status: 'in_progress' }] } } })).toBe(5000);
            expect(refetchInterval({ state: { data: { runs: [{ status: 'completed' }] } } })).toBe(30000);
            expect(refetchInterval({ state: { data: undefined } })).toBe(30000);
        });
    });

    describe('useAgentOpsRunDetail', () => {
        it('is disabled when runId is empty', () => {
            const { wrapper } = createWrapper();
            renderHook(() => useAgentOpsRunDetail(''), { wrapper });
            expect(fetch).not.toHaveBeenCalled();
        });

        it('fetches the run detail and does not poll by default', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ run: { id: 'r1' }, events: [] }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useAgentOpsRunDetail('r1'), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/agent-ops/r1', undefined);
        });

        it('throws with a status-coded message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({}, { ok: false, status: 404 }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useAgentOpsRunDetail('r1'), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Request failed (404)');
        });
    });

    describe('run actions', () => {
        it('useCancelRun POSTs to /cancel and invalidates detail + lists on success', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true }));
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useCancelRun(), { wrapper });
            result.current.mutate({ runId: 'r1' });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/agent-ops/r1/cancel', expect.objectContaining({ method: 'POST', body: '{}' }));
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.agentOps.detail('r1') });
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.agentOps.lists() });
        });

        it('useCancelRun fires a "cancel" toast on error', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ error: 'already finished' }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useCancelRun(), { wrapper });
            result.current.mutate({ runId: 'r1' });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect(toast.error).toHaveBeenCalledWith('Failed to cancel run', { description: 'already finished' });
        });

        it('useApproveRun POSTs to /approve and fires an "update" toast on error', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ error: 'nope' }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useApproveRun(), { wrapper });
            result.current.mutate({ runId: 'r1', body: { approved: true } });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/agent-ops/r1/approve', expect.objectContaining({ body: JSON.stringify({ approved: true }) }));
            expect(toast.error).toHaveBeenCalledWith('Failed to update run', { description: 'nope' });
        });

        it('useResumeRun POSTs to /resume and fires a "resume" toast on error', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ error: 'nope' }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useResumeRun(), { wrapper });
            result.current.mutate({ runId: 'r1' });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/agent-ops/r1/resume', expect.objectContaining({ method: 'POST' }));
            expect(toast.error).toHaveBeenCalledWith('Failed to resume run', { description: 'nope' });
        });
    });
});
