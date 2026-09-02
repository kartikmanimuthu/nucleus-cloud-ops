// @vitest-environment jsdom
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

import { useMemberAttributes, useUpdateMemberAttributes } from './permissions';
import { queryKeys } from './query-keys';

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

describe('permissions queries', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => vi.unstubAllGlobals());

    describe('useMemberAttributes', () => {
        it('is disabled when memberId is null', () => {
            const { wrapper } = createWrapper();
            renderHook(() => useMemberAttributes(null), { wrapper });
            expect(fetch).not.toHaveBeenCalled();
        });

        it('fetches attributes for the member', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: { userId: 'u1', email: 'a@b.co', assignable: [], values: {} } }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useMemberAttributes('m1'), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/settings/members/m1/attributes');
        });

        it('throws with the server error message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false, error: 'not found' }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useMemberAttributes('m1'), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('not found');
        });

        it('falls back to a generic message when the server omits one', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useMemberAttributes('m1'), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to load member attributes.');
        });
    });

    describe('useUpdateMemberAttributes', () => {
        it('PUTs values/reason and invalidates both rbac.all and ability.all', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: {} }));
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useUpdateMemberAttributes('m1'), { wrapper });
            result.current.mutate({ values: { region: 'us-east-1' }, reason: 'onboarding' });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));

            expect(fetch).toHaveBeenCalledWith('/api/settings/members/m1/attributes', expect.objectContaining({
                method: 'PUT', body: JSON.stringify({ values: { region: 'us-east-1' }, reason: 'onboarding' }),
            }));
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.rbac.all });
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.ability.all });
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useUpdateMemberAttributes('m1'), { wrapper });
            result.current.mutate({ values: {} });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to update member attributes.');
        });
    });
});
