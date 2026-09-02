// @vitest-environment jsdom
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

import { useNetworkAvailabilityReport } from './network-links';

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

describe('useNetworkAvailabilityReport', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => vi.unstubAllGlobals());

    it('serializes only the provided filters', async () => {
        (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: [{ accountId: 'a1' }] }));
        const { wrapper } = createWrapper();
        const { result } = renderHook(() => useNetworkAvailabilityReport({ accountId: 'a1', dateFrom: '2026-01-01' }), { wrapper });
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        const url = (fetch as Mock).mock.calls[0][0] as string;
        expect(url).toContain('account=a1');
        expect(url).toContain('dateFrom=2026-01-01');
        expect(url).not.toContain('region=');
        expect(url).not.toContain('dateTo=');
        expect(result.current.data).toEqual([{ accountId: 'a1' }]);
    });

    it('respects options.enabled', () => {
        const { wrapper } = createWrapper();
        renderHook(() => useNetworkAvailabilityReport({}, { enabled: false }), { wrapper });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('throws with a fallback message on failure', async () => {
        (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
        const { wrapper } = createWrapper();
        const { result } = renderHook(() => useNetworkAvailabilityReport({}), { wrapper });
        await waitFor(() => expect(result.current.isError).toBe(true));
        expect((result.current.error as Error).message).toBe('Failed to load network availability report');
    });
});
