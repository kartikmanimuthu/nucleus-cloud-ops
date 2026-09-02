// @vitest-environment jsdom
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { toast } from 'sonner';
import {
    useScheduledTasks,
    useScheduledTaskRuns,
    useCreateScheduledTask,
    useDistillScheduledTask,
} from './agent-ops-scheduled-tasks';
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

describe('agent-ops-scheduled-tasks queries', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
        vi.mocked(toast.error).mockClear();
    });
    afterEach(() => vi.unstubAllGlobals());

    describe('useScheduledTasks', () => {
        it('defaults page=1/limit=25 and omits sortBy when absent', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: [{ id: 't1' }], total: 1, stats: { active: 1, paused: 0, totalRuns: 5 } }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useScheduledTasks(), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));

            const url = (fetch as Mock).mock.calls[0][0] as string;
            expect(url).toContain('page=1');
            expect(url).toContain('limit=25');
            expect(url).not.toContain('sortBy');
            expect(result.current.data).toEqual({ tasks: [{ id: 't1' }], total: 1, stats: { active: 1, paused: 0, totalRuns: 5 } });
        });

        it('defaults sortDir to asc when only sortBy is given', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: [] }));
            const { wrapper } = createWrapper();
            renderHook(() => useScheduledTasks({ sortBy: 'nextRunAt' }), { wrapper });
            await waitFor(() => {
                const url = (fetch as Mock).mock.calls[0][0] as string;
                expect(url).toContain('sortBy=nextRunAt');
                expect(url).toContain('sortDir=asc');
            });
        });

        it('defaults tasks/total/stats when the body omits them', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useScheduledTasks(), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(result.current.data).toEqual({ tasks: [], total: 0, stats: { active: 0, paused: 0, totalRuns: 0 } });
        });

        it('throws with the server error when success is false', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false, error: 'db down' }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useScheduledTasks(), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('db down');
        });

        it('throws with a status-coded message when the HTTP response itself fails', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({}, { ok: false, status: 500 }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useScheduledTasks(), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Request failed (500)');
        });
    });

    describe('useScheduledTaskRuns', () => {
        it('is disabled when taskId is empty', () => {
            const { wrapper } = createWrapper();
            renderHook(() => useScheduledTaskRuns(''), { wrapper });
            expect(fetch).not.toHaveBeenCalled();
        });

        it('defaults page=1/limit=25 and defaults runs/total when omitted', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({}));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useScheduledTaskRuns('t1'), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/agent-ops/scheduled-tasks/t1/runs?page=1&limit=25', undefined);
            expect(result.current.data).toEqual({ runs: [], total: 0 });
        });

        it('throws with a status-coded message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({}, { ok: false, status: 404 }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useScheduledTaskRuns('t1'), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Request failed (404)');
        });
    });

    describe('useCreateScheduledTask', () => {
        it('POSTs the body, invalidates scheduledTasks.all, and returns data.task', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ task: { id: 't1' } }));
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useCreateScheduledTask(), { wrapper });
            result.current.mutate({ name: 'n' });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/agent-ops/scheduled-tasks', expect.objectContaining({
                method: 'POST', body: JSON.stringify({ name: 'n' }),
            }));
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.agentOps.scheduledTasks.all });
            expect(result.current.data).toEqual({ id: 't1' });
        });

        it('fires a sonner error toast with the failure message on error', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ error: 'bad cron' }, { ok: false, status: 400 }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useCreateScheduledTask(), { wrapper });
            result.current.mutate({ name: 'n' });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect(toast.error).toHaveBeenCalledWith('Failed to save scheduled task', { description: 'bad cron' });
        });

        it('treats an unparsable error body as an empty object and falls back to a status message', async () => {
            (fetch as Mock).mockResolvedValue({ ok: false, status: 500, json: () => Promise.reject(new Error('bad json')) });
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useCreateScheduledTask(), { wrapper });
            result.current.mutate({ name: 'n' });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Request failed (500)');
        });
    });

    describe('useDistillScheduledTask', () => {
        it('POSTs the transcript and returns the draft', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: { name: 'n', prompt: 'p', suggestedCron: '0 * * * *', cadenceLabel: 'hourly' } }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useDistillScheduledTask(), { wrapper });
            result.current.mutate('some transcript');
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/agent-ops/scheduled-tasks/distill', expect.objectContaining({
                method: 'POST', body: JSON.stringify({ transcript: 'some transcript' }),
            }));
            expect(result.current.data?.cadenceLabel).toBe('hourly');
        });

        it('throws with a status-coded message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false, status: 422 }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useDistillScheduledTask(), { wrapper });
            result.current.mutate('transcript');
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Request failed (422)');
        });
    });
});
