// @vitest-environment jsdom
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

import {
    useKnowledgeBases,
    useCreateKnowledgeBase,
    useDeleteKnowledgeBase,
    useSetKnowledgeBaseStatus,
    useCreateDocument,
    useUpdateDocument,
} from './knowledge-base';

function createWrapper() {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client: queryClient }, children);
    return { queryClient, wrapper };
}

const knowledgeBasesKey = ['knowledge-bases'] as const;

describe('knowledge-base queries', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => vi.unstubAllGlobals());

    describe('useKnowledgeBases', () => {
        it('returns knowledgeBases and defaults to an empty array when absent', async () => {
            (fetch as Mock).mockResolvedValue({ ok: true, json: () => Promise.resolve({ knowledgeBases: [{ id: 'kb1' }] }) });
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useKnowledgeBases(), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(result.current.data).toEqual([{ id: 'kb1' }]);

            (fetch as Mock).mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
            const { result: empty } = renderHook(() => useKnowledgeBases(), { wrapper: createWrapper().wrapper });
            await waitFor(() => expect(empty.current.isSuccess).toBe(true));
            expect(empty.current.data).toEqual([]);
        });

        it('throws a fixed message when the response is not ok', async () => {
            (fetch as Mock).mockResolvedValue({ ok: false });
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useKnowledgeBases(), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to fetch knowledge bases');
        });
    });

    describe('useCreateKnowledgeBase', () => {
        it('POSTs and invalidates the list on success', async () => {
            (fetch as Mock).mockResolvedValue({ ok: true, json: () => Promise.resolve({ id: 'kb1' }) });
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useCreateKnowledgeBase(), { wrapper });
            result.current.mutate({ name: 'n' });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/knowledge-base', expect.objectContaining({
                method: 'POST', body: JSON.stringify({ name: 'n' }),
            }));
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: knowledgeBasesKey });
        });

        it('throws with a fallback message on failure, tolerating an unparsable body', async () => {
            (fetch as Mock).mockResolvedValue({ ok: false, json: () => Promise.reject(new Error('bad json')) });
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useCreateKnowledgeBase(), { wrapper });
            result.current.mutate({ name: 'n' });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to create knowledge base');
        });
    });

    describe('useDeleteKnowledgeBase', () => {
        it('DELETEs by id and invalidates the list on success', async () => {
            (fetch as Mock).mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useDeleteKnowledgeBase(), { wrapper });
            result.current.mutate('kb1');
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/knowledge-base/kb1', { method: 'DELETE' });
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: knowledgeBasesKey });
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue({ ok: false, json: () => Promise.resolve({}) });
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useDeleteKnowledgeBase(), { wrapper });
            result.current.mutate('kb1');
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Delete failed');
        });
    });

    describe('useSetKnowledgeBaseStatus', () => {
        it('PUTs status and invalidates the list on success', async () => {
            (fetch as Mock).mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useSetKnowledgeBaseStatus(), { wrapper });
            result.current.mutate({ id: 'kb1', status: 'inactive' });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/knowledge-base/kb1', expect.objectContaining({
                method: 'PUT', body: JSON.stringify({ status: 'inactive' }),
            }));
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: knowledgeBasesKey });
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue({ ok: false, json: () => Promise.resolve({}) });
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSetKnowledgeBaseStatus(), { wrapper });
            result.current.mutate({ id: 'kb1', status: 'active' });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to update status');
        });
    });

    describe('useCreateDocument', () => {
        it('POSTs to the kb-scoped documents endpoint and invalidates the list', async () => {
            (fetch as Mock).mockResolvedValue({ ok: true, json: () => Promise.resolve({ id: 'd1' }) });
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useCreateDocument('kb1'), { wrapper });
            result.current.mutate({ name: 'doc', content: 'c' });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/knowledge-base/kb1/documents', expect.objectContaining({ method: 'POST' }));
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: knowledgeBasesKey });
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue({ ok: false, json: () => Promise.resolve({}) });
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useCreateDocument('kb1'), { wrapper });
            result.current.mutate({ name: 'doc', content: 'c' });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to create document');
        });
    });

    describe('useUpdateDocument', () => {
        it('strips dsId from the body and PUTs to the sources endpoint', async () => {
            (fetch as Mock).mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useUpdateDocument('kb1'), { wrapper });
            result.current.mutate({ dsId: 'd1', name: 'renamed', content: 'c' });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/knowledge-base/kb1/sources/d1', expect.objectContaining({
                method: 'PUT', body: JSON.stringify({ name: 'renamed', content: 'c' }),
            }));
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: knowledgeBasesKey });
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue({ ok: false, json: () => Promise.resolve({}) });
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useUpdateDocument('kb1'), { wrapper });
            result.current.mutate({ dsId: 'd1', content: 'c' });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to update document');
        });
    });
});
