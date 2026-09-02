// @vitest-environment jsdom
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

import { useMyOrgs, useSwitchOrg } from './orgs';

function createWrapper() {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client: queryClient }, children);
    return { queryClient, wrapper };
}

describe('orgs queries', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => vi.unstubAllGlobals());

    describe('useMyOrgs', () => {
        it('returns orgs and defaults to an empty array when absent', async () => {
            (fetch as Mock).mockResolvedValue({ ok: true, json: () => Promise.resolve({ orgs: [{ id: 't1' }] }) });
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useMyOrgs(), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/tenants/my-orgs');
            expect(result.current.data).toEqual([{ id: 't1' }]);
        });

        it('throws a fixed message when the response is not ok', async () => {
            (fetch as Mock).mockResolvedValue({ ok: false });
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useMyOrgs(), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to fetch orgs');
        });
    });

    describe('useSwitchOrg', () => {
        it('POSTs the tenantId and returns the parsed body', async () => {
            (fetch as Mock).mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true }) });
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSwitchOrg(), { wrapper });
            result.current.mutate('t1');
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/tenants/switch', expect.objectContaining({
                method: 'POST', body: JSON.stringify({ tenantId: 't1' }),
            }));
            expect(result.current.data).toEqual({ success: true });
        });

        it('tolerates an unparsable success body', async () => {
            (fetch as Mock).mockResolvedValue({ ok: true, json: () => Promise.reject(new Error('bad json')) });
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSwitchOrg(), { wrapper });
            result.current.mutate('t1');
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(result.current.data).toEqual({});
        });

        it('throws a fixed message when the response is not ok', async () => {
            (fetch as Mock).mockResolvedValue({ ok: false });
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSwitchOrg(), { wrapper });
            result.current.mutate('t1');
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to switch org');
        });
    });
});
