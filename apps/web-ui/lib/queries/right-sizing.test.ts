// @vitest-environment jsdom
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

import {
    useRightSizingRecommendations,
    useRightSizingSummary,
    useRunRightSizingScan,
    useRightSizingRecommendation,
    useUpdateRightSizingRecommendation,
} from './right-sizing';
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

describe('right-sizing queries', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => vi.unstubAllGlobals());

    describe('useRightSizingRecommendations', () => {
        it('serializes every optional filter and defaults total to 0', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: [{ id: 'r1' }] }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(
                () =>
                    useRightSizingRecommendations({
                        page: 1, limit: 20, sort: 'savings', search: '  x  ',
                        resourceType: 'ec2', finding: 'oversized', status: 'open', accountId: 'a1',
                    }),
                { wrapper },
            );
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            const url = (fetch as Mock).mock.calls[0][0] as string;
            expect(url).toContain('sort=savings');
            expect(url).toContain('search=x');
            expect(url).toContain('resourceType=ec2');
            expect(url).toContain('finding=oversized');
            expect(url).toContain('status=open');
            expect(url).toContain('account=a1');
            expect(result.current.data?.total).toBe(0);
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(
                () => useRightSizingRecommendations({ page: 1, limit: 20, sort: 'savings' }),
                { wrapper },
            );
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to load recommendations');
        });
    });

    describe('useRightSizingSummary', () => {
        it('returns the summary payload', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: { total: 5 } }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useRightSizingSummary(), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/right-sizing/summary');
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useRightSizingSummary(), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to load summary');
        });
    });

    describe('useRunRightSizingScan', () => {
        it('POSTs and invalidates rightSizing.all on success', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true }));
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useRunRightSizingScan(), { wrapper });
            result.current.mutate();
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/right-sizing/runs', { method: 'POST' });
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.rightSizing.all });
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useRunRightSizingScan(), { wrapper });
            result.current.mutate();
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to start scan');
        });
    });

    describe('useRightSizingRecommendation', () => {
        it('does not fetch when id is undefined', () => {
            const { wrapper } = createWrapper();
            renderHook(() => useRightSizingRecommendation(undefined), { wrapper });
            expect(fetch).not.toHaveBeenCalled();
        });

        it('fetches the recommendation detail by id', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: { recommendation: { id: 'r1' }, resource: null, account: null } }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useRightSizingRecommendation('r1'), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/right-sizing/recommendations/r1');
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useRightSizingRecommendation('r1'), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Recommendation not found');
        });
    });

    describe('useUpdateRightSizingRecommendation', () => {
        it('PATCHes status/snoozeUntil and invalidates rightSizing.all on success', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: { id: 'r1' } }));
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useUpdateRightSizingRecommendation(), { wrapper });
            result.current.mutate({ id: 'r1', status: 'snoozed', snoozeUntil: '2026-09-01' });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/right-sizing/recommendations/r1', expect.objectContaining({
                method: 'PATCH', body: JSON.stringify({ status: 'snoozed', snoozeUntil: '2026-09-01' }),
            }));
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.rightSizing.all });
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useUpdateRightSizingRecommendation(), { wrapper });
            result.current.mutate({ id: 'r1', status: 'dismissed' });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to update recommendation');
        });
    });
});
