// @vitest-environment jsdom
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

import {
    useAgentMemories,
    useAgentMemory,
    useDeleteAgentMemory,
    fetchAllAgentMemories,
} from './agent-memories';
import { queryKeys } from '@/lib/queries/query-keys';

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

describe('agent-memories queries', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => vi.unstubAllGlobals());

    describe('useAgentMemories', () => {
        it('joins categories with a comma, preferring it over a single category, and includes sort/dir', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: [{ id: 'm1' }], total: 1 }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(
                () =>
                    useAgentMemories({
                        category: 'preference',
                        categories: ['preference', 'fact'],
                        search: '  x  ',
                        sortBy: 'key',
                        limit: 10,
                        page: 2,
                    }),
                { wrapper },
            );
            await waitFor(() => expect(result.current.isSuccess).toBe(true));

            const url = (fetch as Mock).mock.calls[0][0] as string;
            expect(url).toContain('category=preference%2Cfact');
            expect(url).toContain('search=x');
            expect(url).toContain('sort=key');
            expect(url).toContain('dir=asc');
            expect(url).toContain('limit=10');
            expect(url).toContain('page=2');
        });

        it('defaults dir to asc only when sortBy is set, and omits sort otherwise', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: [] }));
            const { wrapper } = createWrapper();
            renderHook(() => useAgentMemories(), { wrapper });
            await waitFor(() => {
                const url = (fetch as Mock).mock.calls[0][0] as string;
                expect(url).not.toContain('sort=');
                expect(url).toContain('limit=100');
                expect(url).toContain('page=1');
            });
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useAgentMemories(), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to load memories');
        });
    });

    describe('useAgentMemory', () => {
        it('does not fetch when id is undefined', () => {
            const { wrapper } = createWrapper();
            renderHook(() => useAgentMemory(undefined), { wrapper });
            expect(fetch).not.toHaveBeenCalled();
        });

        it('fetches the memory by id', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: { id: 'm1' } }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useAgentMemory('m1'), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/agent-memories/m1');
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useAgentMemory('m1'), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to load memory');
        });
    });

    describe('useDeleteAgentMemory', () => {
        it('DELETEs by id and invalidates agentMemories.all on success', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true }));
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useDeleteAgentMemory(), { wrapper });
            result.current.mutate('m1');
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/agent-memories/m1', { method: 'DELETE' });
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.agentMemories.all });
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useDeleteAgentMemory(), { wrapper });
            result.current.mutate('m1');
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to delete memory');
        });
    });

    describe('fetchAllAgentMemories', () => {
        it('stops paging once accumulated memories reach the reported total', async () => {
            (fetch as Mock)
                .mockResolvedValueOnce(jsonRes({ success: true, data: Array(500).fill({ id: 'm' }), total: 600 }))
                .mockResolvedValueOnce(jsonRes({ success: true, data: Array(100).fill({ id: 'm' }), total: 600 }));

            const result = await fetchAllAgentMemories();
            expect(fetch).toHaveBeenCalledTimes(2);
            expect(result.memories).toHaveLength(600);
            expect(result.total).toBe(600);
        });

        it('stops paging once a page returns fewer rows than the page limit, even below total', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: [{ id: 'm1' }], total: 999 }));
            const result = await fetchAllAgentMemories();
            expect(fetch).toHaveBeenCalledTimes(1);
            expect(result.memories).toHaveLength(1);
            expect(result.total).toBe(999);
        });

        it('is capped at 100 pages as a runaway-loop safety net', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: Array(500).fill({ id: 'm' }), total: 1_000_000 }));
            const result = await fetchAllAgentMemories();
            expect(fetch).toHaveBeenCalledTimes(100);
            expect(result.memories).toHaveLength(50_000);
        });

        it('throws with a fallback message when a page fails', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            await expect(fetchAllAgentMemories()).rejects.toThrow('Failed to load memories');
        });
    });
});
