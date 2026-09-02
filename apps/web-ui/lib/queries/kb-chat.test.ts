// @vitest-environment jsdom
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

import { useKBChatSessions, useKBChatMessages, useDeleteKBChatSession } from './kb-chat';
import { queryKeys } from '@/lib/queries/query-keys';

function createWrapper() {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client: queryClient }, children);
    return { queryClient, wrapper };
}

describe('kb-chat queries', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => vi.unstubAllGlobals());

    describe('useKBChatSessions', () => {
        it('returns sessions and defaults to an empty array when data is missing', async () => {
            (fetch as Mock).mockResolvedValue({ ok: true, json: () => Promise.resolve({ data: [{ id: 's1' }] }) });
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useKBChatSessions(), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/knowledge-base/sessions');
            expect(result.current.data).toEqual([{ id: 's1' }]);
        });

        it('throws a fixed message when the response is not ok', async () => {
            (fetch as Mock).mockResolvedValue({ ok: false });
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useKBChatSessions(), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to fetch sessions');
        });
    });

    describe('useKBChatMessages', () => {
        it('is disabled when sessionId is null', () => {
            const { wrapper } = createWrapper();
            renderHook(() => useKBChatMessages(null), { wrapper });
            expect(fetch).not.toHaveBeenCalled();
        });

        it('encodes the sessionId and fetches history', async () => {
            (fetch as Mock).mockResolvedValue({ ok: true, json: () => Promise.resolve({ data: { messages: [], knowledgeBaseId: null, title: 't' } }) });
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useKBChatMessages('s 1'), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/knowledge-base/sessions/s%201/history');
        });

        it('throws a fixed message when the response is not ok', async () => {
            (fetch as Mock).mockResolvedValue({ ok: false });
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useKBChatMessages('s1'), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to load history');
        });
    });

    describe('useDeleteKBChatSession', () => {
        it('DELETEs the encoded sessionId and invalidates sessions on success', async () => {
            (fetch as Mock).mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useDeleteKBChatSession(), { wrapper });
            result.current.mutate('s 1');
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/knowledge-base/sessions/s%201', { method: 'DELETE' });
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.kbChat.sessions() });
        });

        it('throws with a fallback message on failure, tolerating an unparsable body', async () => {
            (fetch as Mock).mockResolvedValue({ ok: false, json: () => Promise.reject(new Error('bad json')) });
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useDeleteKBChatSession(), { wrapper });
            result.current.mutate('s1');
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Delete failed');
        });
    });
});
