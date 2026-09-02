// @vitest-environment jsdom
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

vi.mock('@/lib/client-audit-service-api', () => ({
    ClientAuditService: { getAuditLogs: vi.fn(), getAuditLogStats: vi.fn() },
}));

import { ClientAuditService } from '@/lib/client-audit-service-api';
import { useAuditLogs, useAuditLogStats, useAuditFilterOptions } from './audit';

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

describe('audit queries', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => vi.unstubAllGlobals());

    describe('useAuditLogs', () => {
        it('defaults filters to {} when omitted', async () => {
            vi.mocked(ClientAuditService.getAuditLogs).mockResolvedValue({ logs: [], nextPageToken: null } as any);
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useAuditLogs(), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(ClientAuditService.getAuditLogs).toHaveBeenCalledWith({});
        });

        it('forwards filters and seeds the cache from initialData', () => {
            const seed = { logs: [{ id: 'l1' }], nextPageToken: null } as any;
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useAuditLogs({ severity: 'high' } as any, { initialData: seed }), { wrapper });
            expect(result.current.data).toEqual(seed);
        });
    });

    describe('useAuditLogStats', () => {
        it('defaults filters to {} when omitted', async () => {
            vi.mocked(ClientAuditService.getAuditLogStats).mockResolvedValue({ total: 0 } as any);
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useAuditLogStats(), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(ClientAuditService.getAuditLogStats).toHaveBeenCalledWith({});
        });

        it('seeds the cache from initialData', () => {
            const seed = { total: 5 } as any;
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useAuditLogStats(undefined, { initialData: seed }), { wrapper });
            expect(result.current.data).toEqual(seed);
        });
    });

    describe('useAuditFilterOptions', () => {
        it('returns filter option lists and caches for 5 minutes', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: { sources: ['slack'], users: [], resourceTypes: [], eventTypes: [], severities: [], statuses: [], userTypes: [] } }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useAuditFilterOptions(), { wrapper });
            await waitFor(() => expect(result.current.isPlaceholderData).toBe(false));
            expect(fetch).toHaveBeenCalledWith('/api/audit/filters');
            expect(result.current.data?.sources).toEqual(['slack']);
        });

        it('shows the empty placeholder immediately, before the fetch resolves', () => {
            (fetch as Mock).mockReturnValue(new Promise(() => {}));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useAuditFilterOptions(), { wrapper });
            expect(result.current.data).toEqual({
                sources: [], users: [], resourceTypes: [], eventTypes: [], severities: [], statuses: [], userTypes: [],
            });
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useAuditFilterOptions(), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to fetch audit filter options');
        });
    });
});
