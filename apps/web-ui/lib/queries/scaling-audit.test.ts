// @vitest-environment jsdom
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

import {
    useScalingEvents,
    useScalingResources,
    useScalingEvent,
    useScalingAuditSummary,
    useScalingAuditCoverage,
    useScalingAuditRuns,
    useRunScalingAuditScan,
    useExportScalingAudit,
} from './scaling-audit';
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

describe('scaling-audit queries', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => vi.unstubAllGlobals());

    describe('useScalingEvents', () => {
        it('serializes every filter, preferring scalingType over excludeScalingTypes', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: [], meta: { total: 3 } }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(
                () =>
                    useScalingEvents({
                        page: 2,
                        limit: 25,
                        search: '  foo  ',
                        accountId: 'a1',
                        region: 'us-east-1',
                        scope: 'account',
                        source: 'cloudtrail',
                        scalingType: 'ecs',
                        excludeScalingTypes: ['asg'],
                        effect: 'all',
                        dateFrom: '2026-01-01',
                        dateTo: '2026-01-31',
                    }),
                { wrapper },
            );
            await waitFor(() => expect(result.current.isSuccess).toBe(true));

            const url = (fetch as Mock).mock.calls[0][0] as string;
            expect(url).toContain('page=2');
            expect(url).toContain('limit=25');
            expect(url).toContain('search=foo');
            expect(url).toContain('account=a1');
            expect(url).toContain('region=us-east-1');
            expect(url).toContain('scope=account');
            expect(url).toContain('source=cloudtrail');
            expect(url).toContain('scalingType=ecs');
            expect(url).not.toContain('excludeScalingTypes');
            expect(url).toContain('effect=all');
            expect(url).toContain('dateFrom=2026-01-01');
            expect(url).toContain('dateTo=2026-01-31');
            expect(result.current.data).toEqual({ data: [], total: 3 });
        });

        it('falls back to excludeScalingTypes joined by comma when scalingType is absent', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: [] }));
            const { wrapper } = createWrapper();
            renderHook(
                () => useScalingEvents({ page: 1, limit: 10, excludeScalingTypes: ['asg', 'ecs'] }),
                { wrapper },
            );
            await waitFor(() => {
                const url = (fetch as Mock).mock.calls[0][0] as string;
                expect(url).toContain('excludeScalingTypes=asg%2Cecs');
            });
        });

        it('respects options.enabled and defaults meta.total to 0', async () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(
                () => useScalingEvents({ page: 1, limit: 10 }, { enabled: false }),
                { wrapper },
            );
            expect(fetch).not.toHaveBeenCalled();
            expect(result.current.fetchStatus).toBe('idle');
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useScalingEvents({ page: 1, limit: 10 }), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to load scaling events');
        });
    });

    describe('useScalingResources', () => {
        it('serializes filters without the excludeScalingTypes special-case', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: [], meta: { total: 7 } }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(
                () => useScalingResources({ page: 1, limit: 10, scalingType: 'ecs', effect: 'capacity_changes' }),
                { wrapper },
            );
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            const url = (fetch as Mock).mock.calls[0][0] as string;
            expect(url).toContain('scalingType=ecs');
            expect(url).toContain('effect=capacity_changes');
            expect(result.current.data).toEqual({ data: [], total: 7 });
        });

        it('respects options.enabled', () => {
            const { wrapper } = createWrapper();
            renderHook(() => useScalingResources({ page: 1, limit: 10 }, { enabled: false }), { wrapper });
            expect(fetch).not.toHaveBeenCalled();
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useScalingResources({ page: 1, limit: 10 }), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to load resources');
        });
    });

    describe('useScalingEvent', () => {
        it('does not fetch when id is undefined', () => {
            const { wrapper } = createWrapper();
            renderHook(() => useScalingEvent(undefined), { wrapper });
            expect(fetch).not.toHaveBeenCalled();
        });

        it('fetches the event by id', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: { id: 'e1' } }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useScalingEvent('e1'), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/scaling-audit/events/e1');
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useScalingEvent('e1'), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Scaling event not found');
        });
    });

    describe('useScalingAuditSummary', () => {
        it('returns the summary payload', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: { total: 1, facets: {} } }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useScalingAuditSummary(), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/scaling-audit/summary');
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useScalingAuditSummary(), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to load summary');
        });
    });

    describe('useScalingAuditCoverage', () => {
        it('returns the coverage payload', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: [{ region: 'us-east-1' }] }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useScalingAuditCoverage(), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/scaling-audit/coverage');
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useScalingAuditCoverage(), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to load coverage');
        });
    });

    describe('useScalingAuditRuns', () => {
        it('defaults page=1/limit=20 and forwards custom values', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: [], meta: { total: 2 } }));
            const { wrapper } = createWrapper();
            renderHook(() => useScalingAuditRuns(), { wrapper });
            await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/scaling-audit/runs?page=1&limit=20'));

            (fetch as Mock).mockClear();
            renderHook(() => useScalingAuditRuns(3, 5), { wrapper: createWrapper().wrapper });
            await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/scaling-audit/runs?page=3&limit=5'));
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useScalingAuditRuns(), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to load runs');
        });
    });

    describe('useRunScalingAuditScan', () => {
        it('POSTs and invalidates scalingAudit.all on success', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, alreadyRunning: false }));
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useRunScalingAuditScan(), { wrapper });
            result.current.mutate();
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/scaling-audit/runs', { method: 'POST' });
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.scalingAudit.all });
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useRunScalingAuditScan(), { wrapper });
            result.current.mutate();
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to start scan');
        });
    });

    describe('useExportScalingAudit', () => {
        let createObjectURLSpy: Mock;
        let revokeObjectURLSpy: Mock;
        let clickSpy: Mock;

        beforeEach(() => {
            createObjectURLSpy = vi.fn().mockReturnValue('blob:mock-url');
            revokeObjectURLSpy = vi.fn();
            vi.stubGlobal('URL', { ...URL, createObjectURL: createObjectURLSpy, revokeObjectURL: revokeObjectURLSpy });
            clickSpy = vi.fn();
            vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(clickSpy);
        });

        it('downloads the export using the filename from Content-Disposition', async () => {
            const blob = new Blob(['data']);
            (fetch as Mock).mockResolvedValue({
                ok: true,
                blob: () => Promise.resolve(blob),
                headers: { get: () => 'attachment; filename="report.xlsx"' },
            });
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useExportScalingAudit(), { wrapper });
            result.current.mutate({ format: 'xlsx', accountId: 'a1', search: 'x' });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));

            expect(fetch).toHaveBeenCalledWith(
                '/api/scaling-audit/export',
                expect.objectContaining({
                    method: 'POST',
                    body: JSON.stringify({
                        format: 'xlsx',
                        accountId: 'a1',
                        region: undefined,
                        scope: undefined,
                        source: undefined,
                        scalingType: undefined,
                        searchTerm: 'x',
                        effect: undefined,
                        dateFrom: undefined,
                        dateTo: undefined,
                    }),
                }),
            );
            expect(createObjectURLSpy).toHaveBeenCalledWith(blob);
            expect(clickSpy).toHaveBeenCalled();
            expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:mock-url');
        });

        it('falls back to a generated filename when Content-Disposition is absent', async () => {
            (fetch as Mock).mockResolvedValue({
                ok: true,
                blob: () => Promise.resolve(new Blob(['data'])),
                headers: { get: () => null },
            });
            const appendSpy = vi.spyOn(document.body, 'appendChild');
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useExportScalingAudit(), { wrapper });
            result.current.mutate({ format: 'pdf' });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));

            const anchor = appendSpy.mock.calls.at(-1)?.[0] as HTMLAnchorElement;
            expect(anchor.download).toBe('scaling-audit-export.pdf');
        });

        it('throws the server error message when the response is not ok', async () => {
            (fetch as Mock).mockResolvedValue({
                ok: false,
                json: () => Promise.resolve({ error: 'export failed' }),
            });
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useExportScalingAudit(), { wrapper });
            result.current.mutate({ format: 'xlsx' });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('export failed');
        });

        it('falls back to a generic message when the error body is unparsable', async () => {
            (fetch as Mock).mockResolvedValue({
                ok: false,
                json: () => Promise.reject(new Error('not json')),
            });
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useExportScalingAudit(), { wrapper });
            result.current.mutate({ format: 'xlsx' });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to export scaling audit records');
        });
    });
});
