// @vitest-environment jsdom
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

import { useThreads, useDeleteThread, useRenameThread } from './threads';
import { queryKeys } from '@/lib/queries/query-keys';

function createWrapper() {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client: queryClient }, children);
    return { queryClient, wrapper };
}

describe('threads queries', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => vi.unstubAllGlobals());

    describe('useThreads', () => {
        it('returns the thread list', async () => {
            (fetch as Mock).mockResolvedValue({ ok: true, json: () => Promise.resolve([{ id: 't1' }]) });
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useThreads(), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/threads');
            expect(result.current.data).toEqual([{ id: 't1' }]);
        });

        it('throws a fixed message when the response is not ok', async () => {
            (fetch as Mock).mockResolvedValue({ ok: false });
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useThreads(), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to fetch threads');
        });
    });

    describe('useDeleteThread', () => {
        it('DELETEs by id and invalidates threads.all on success', async () => {
            (fetch as Mock).mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useDeleteThread(), { wrapper });
            result.current.mutate('t1');
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/threads/t1', { method: 'DELETE' });
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.threads.all });
        });

        it('throws with a fallback message on failure, tolerating an unparsable body', async () => {
            (fetch as Mock).mockResolvedValue({ ok: false, json: () => Promise.reject(new Error('bad json')) });
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useDeleteThread(), { wrapper });
            result.current.mutate('t1');
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to delete thread');
        });
    });

    describe('useRenameThread', () => {
        it('PATCHes { title } and invalidates threads.all on success', async () => {
            (fetch as Mock).mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useRenameThread(), { wrapper });
            result.current.mutate({ id: 't1', title: 'New title' });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/threads/t1', expect.objectContaining({
                method: 'PATCH', body: JSON.stringify({ title: 'New title' }),
            }));
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.threads.all });
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue({ ok: false, json: () => Promise.resolve({}) });
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useRenameThread(), { wrapper });
            result.current.mutate({ id: 't1', title: 'x' });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to rename thread');
        });
    });
});
