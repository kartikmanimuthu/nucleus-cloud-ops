// @vitest-environment jsdom
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

import {
    useSpotGuardServices,
    useSpotGuardService,
    useSpotGuardEligible,
    useSpotGuardEvents,
    useSpotGuardFacets,
    useSpotGuardSummary,
    useSpotGuardReport,
    useSpotGuardSettings,
    useEnableSpot,
    useDisableSpot,
    useSetManagementState,
    useSaveSpotGuardSettings,
    useTriggerSpotRestore,
} from './spot-guard';
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

describe('spot-guard queries', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => vi.unstubAllGlobals());

    describe('useSpotGuardServices', () => {
        it('builds params, trims search, and drops undefined/empty values', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: [{ id: 's1' }], meta: { total: 4 } }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(
                () =>
                    useSpotGuardServices({
                        page: 1,
                        limit: 20,
                        search: '  web  ',
                        accountId: 'a1',
                        region: '',
                        clusterName: 'prod',
                        capacityState: 'spot',
                        managementState: 'managed',
                    }),
                { wrapper },
            );
            await waitFor(() => expect(result.current.isSuccess).toBe(true));

            const url = (fetch as Mock).mock.calls[0][0] as string;
            expect(url).toContain('/api/spot-guard/services?');
            expect(url).toContain('search=web');
            expect(url).toContain('account=a1');
            expect(url).not.toContain('region=');
            expect(url).toContain('cluster=prod');
            expect(url).toContain('capacityState=spot');
            expect(url).toContain('managementState=managed');
            expect(result.current.data).toEqual({ data: [{ id: 's1' }], total: 4 });
        });

        it('does not poll by default and polls every 5s when pollWhilePending is set', () => {
            const { wrapper } = createWrapper();
            const { result: idle } = renderHook(
                () => useSpotGuardServices({ page: 1, limit: 20 }),
                { wrapper },
            );
            expect(idle.current.isRefetching).toBe(false);

            const { result: polling } = renderHook(
                () => useSpotGuardServices({ page: 1, limit: 20 }, { pollWhilePending: true }),
                { wrapper: createWrapper().wrapper },
            );
            expect(polling.current).toBeDefined();
        });

        it('surfaces the server error message on a non-success envelope', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false, error: 'db unavailable' }, { ok: false, status: 503 }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSpotGuardServices({ page: 1, limit: 20 }), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('db unavailable');
        });

        it('falls back to a status-coded message when the body has no error field', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false, status: 503 }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSpotGuardServices({ page: 1, limit: 20 }), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Request failed with 503');
        });

        it('treats an unparsable body as a failure', async () => {
            (fetch as Mock).mockResolvedValue({
                ok: false,
                status: 500,
                json: () => Promise.reject(new Error('bad json')),
            });
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSpotGuardServices({ page: 1, limit: 20 }), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Request failed with 500');
        });

        it('falls back total to the array length when meta.total is absent', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: [{ id: 's1' }, { id: 's2' }] }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSpotGuardServices({ page: 1, limit: 20 }), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(result.current.data?.total).toBe(2);
        });
    });

    describe('useSpotGuardService', () => {
        it('is disabled when id is null', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSpotGuardService(null), { wrapper });
            expect(fetch).not.toHaveBeenCalled();
            expect(result.current.fetchStatus).toBe('idle');
        });

        it('fetches the service+events by id', async () => {
            (fetch as Mock).mockResolvedValue(
                jsonRes({ success: true, data: { service: { id: 's1' }, events: [] } }),
            );
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSpotGuardService('s1'), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/spot-guard/services/s1');
            expect(result.current.data).toEqual({ service: { id: 's1' }, events: [] });
        });
    });

    describe('useSpotGuardEligible', () => {
        it('builds params from filters', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: [], meta: { total: 0 } }));
            const { wrapper } = createWrapper();
            renderHook(
                () => useSpotGuardEligible({ page: 1, limit: 10, search: 'x', eligibility: 'eligible' }),
                { wrapper },
            );
            await waitFor(() => {
                const url = (fetch as Mock).mock.calls[0][0] as string;
                expect(url).toContain('eligibility=eligible');
            });
        });
    });

    describe('useSpotGuardEvents', () => {
        it('joins eventTypes with commas and omits it when empty', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: [] }));
            const { wrapper } = createWrapper();
            renderHook(
                () => useSpotGuardEvents({ page: 1, limit: 10, eventTypes: ['restore', 'skip'] }),
                { wrapper },
            );
            await waitFor(() => {
                const url = (fetch as Mock).mock.calls[0][0] as string;
                expect(url).toContain('eventTypes=restore%2Cskip');
            });

            (fetch as Mock).mockClear();
            renderHook(() => useSpotGuardEvents({ page: 1, limit: 10, eventTypes: [] }), { wrapper: createWrapper().wrapper });
            await waitFor(() => {
                const url = (fetch as Mock).mock.calls[0][0] as string;
                expect(url).not.toContain('eventTypes');
            });
        });

        it('respects opts.enabled', () => {
            const { wrapper } = createWrapper();
            renderHook(() => useSpotGuardEvents({ page: 1, limit: 10 }, { enabled: false }), { wrapper });
            expect(fetch).not.toHaveBeenCalled();
        });
    });

    describe('useSpotGuardFacets / useSpotGuardSummary / useSpotGuardSettings', () => {
        it('unwrap data from the envelope', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: { regions: ['us-east-1'], clusters: [] } }));
            const { wrapper } = createWrapper();
            const { result: facets } = renderHook(() => useSpotGuardFacets(), { wrapper });
            await waitFor(() => expect(facets.current.isSuccess).toBe(true));
            expect(facets.current.data).toEqual({ regions: ['us-east-1'], clusters: [] });

            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: { total: 3 } }));
            const { result: summary } = renderHook(() => useSpotGuardSummary(), { wrapper: createWrapper().wrapper });
            await waitFor(() => expect(summary.current.isSuccess).toBe(true));
            expect(summary.current.data).toEqual({ total: 3 });

            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: { slackChannelId: '#c', slackEnabled: true, reportTimezone: 'UTC' } }));
            const { result: settings } = renderHook(() => useSpotGuardSettings(), { wrapper: createWrapper().wrapper });
            await waitFor(() => expect(settings.current.isSuccess).toBe(true));
            expect(settings.current.data?.reportTimezone).toBe('UTC');
        });
    });

    describe('useSpotGuardReport', () => {
        it('builds from/to params and respects opts.enabled', async () => {
            const { wrapper } = createWrapper();
            renderHook(() => useSpotGuardReport({ from: '2026-01-01' }, { enabled: false }), { wrapper });
            expect(fetch).not.toHaveBeenCalled();

            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: {} }));
            renderHook(() => useSpotGuardReport({ from: '2026-01-01', to: '2026-01-31' }), { wrapper: createWrapper().wrapper });
            await waitFor(() => {
                const url = (fetch as Mock).mock.calls[0][0] as string;
                expect(url).toContain('from=2026-01-01');
                expect(url).toContain('to=2026-01-31');
            });
        });
    });

    describe('useEnableSpot', () => {
        it('POSTs confirm:true plus the rest of the payload and invalidates the domain', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: { id: 's1' } }));
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useEnableSpot(), { wrapper });
            result.current.mutate({ id: 's 1', confirmServiceName: 'svc', spotWeight: 2 });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));

            expect(fetch).toHaveBeenCalledWith(
                '/api/spot-guard/services/s%201/enable',
                expect.objectContaining({
                    method: 'POST',
                    body: JSON.stringify({ confirm: true, confirmServiceName: 'svc', spotWeight: 2 }),
                }),
            );
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.spotGuard.all });
        });

        it('surfaces the 409 conflict message verbatim', async () => {
            (fetch as Mock).mockResolvedValue(
                jsonRes({ success: false, error: 'capacity providers already set' }, { ok: false, status: 409 }),
            );
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useEnableSpot(), { wrapper });
            result.current.mutate({ id: 's1', confirmServiceName: 'svc' });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('capacity providers already set');
        });
    });

    describe('useDisableSpot', () => {
        it('POSTs confirm:true + confirmServiceName and invalidates the domain', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: { id: 's1' } }));
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useDisableSpot(), { wrapper });
            result.current.mutate({ id: 's1', confirmServiceName: 'svc' });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith(
                '/api/spot-guard/services/s1/disable',
                expect.objectContaining({ body: JSON.stringify({ confirm: true, confirmServiceName: 'svc' }) }),
            );
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.spotGuard.all });
        });
    });

    describe('useSetManagementState', () => {
        it('PATCHes the managementState and invalidates the domain', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: { id: 's1' } }));
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useSetManagementState(), { wrapper });
            result.current.mutate({ id: 's1', managementState: 'unmanaged' });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith(
                '/api/spot-guard/services/s1',
                expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ managementState: 'unmanaged' }) }),
            );
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.spotGuard.all });
        });

        it('falls back to a status-coded message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false, status: 422 }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSetManagementState(), { wrapper });
            result.current.mutate({ id: 's1', managementState: 'unmanaged' });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Request failed with 422');
        });
    });

    describe('useSaveSpotGuardSettings', () => {
        it('PUTs the settings and invalidates only the settings key', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: { slackChannelId: '#c', slackEnabled: true, reportTimezone: 'UTC' } }));
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useSaveSpotGuardSettings(), { wrapper });
            result.current.mutate({ slackChannelId: '#c' });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith(
                '/api/spot-guard/settings',
                expect.objectContaining({ method: 'PUT', body: JSON.stringify({ slackChannelId: '#c' }) }),
            );
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.spotGuard.settings() });
            expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: queryKeys.spotGuard.all });
        });

        it('surfaces the validation error message verbatim', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false, error: 'invalid timezone' }, { ok: false, status: 400 }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSaveSpotGuardSettings(), { wrapper });
            result.current.mutate({ reportTimezone: 'nowhere' });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('invalid timezone');
        });
    });

    describe('useTriggerSpotRestore', () => {
        it('POSTs with no body and invalidates the domain', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: { jobId: 'j1', alreadyQueued: false } }));
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useTriggerSpotRestore(), { wrapper });
            result.current.mutate({ id: 's1' });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith(
                '/api/spot-guard/services/s1/restore',
                expect.objectContaining({ method: 'POST', body: JSON.stringify({}) }),
            );
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.spotGuard.all });
        });
    });
});
