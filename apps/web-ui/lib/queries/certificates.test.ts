// @vitest-environment jsdom
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

import {
    useCertificates,
    useCertificate,
    useCertificateContent,
    useCertificateVersions,
    useCertificateAccounts,
    useCertificateAccountDetail,
    useCertificateExecutions,
    useUploadCertificate,
    useDeleteCertificate,
    useDiscoverCertificate,
    useDeployCertificate,
    useReimportCertificate,
    useUploadVersion,
    useActivateVersion,
    useDeleteVersion,
} from './certificates';
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
    status: opts.status ?? (opts.ok === false ? 500 : 200),
    json: () => Promise.resolve(body),
});

describe('certificates queries', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => vi.unstubAllGlobals());

    describe('useCertificates', () => {
        it('sends status/search/limit/page and returns data+total', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: [{ id: 'c1' }], total: 5 }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(
                () => useCertificates({ status: 'expiring', search: '  foo  ', limit: 10, page: 2 }),
                { wrapper },
            );
            await waitFor(() => expect(result.current.isSuccess).toBe(true));

            const url = (fetch as Mock).mock.calls[0][0] as string;
            expect(url).toContain('status=expiring');
            expect(url).toContain('search=foo');
            expect(url).toContain('limit=10');
            expect(url).toContain('page=2');
            expect(result.current.data).toEqual({ data: [{ id: 'c1' }], total: 5 });
        });

        it('defaults limit=100/page=1 and omits blank status/search', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: [] }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useCertificates({ status: '', search: '   ' }), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));

            const url = (fetch as Mock).mock.calls[0][0] as string;
            expect(url).toContain('limit=100');
            expect(url).toContain('page=1');
            expect(url).not.toContain('status=');
            expect(url).not.toContain('search=');
            expect(result.current.data?.total).toBe(0);
        });

        it('throws the server error message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false, error: 'boom' }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useCertificates(), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('boom');
        });

        it('falls back to a generic message when the server omits one', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useCertificates(), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to load certificates');
        });
    });

    describe('useCertificate', () => {
        it('does not fetch when id is undefined', () => {
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useCertificate(undefined), { wrapper });
            expect(fetch).not.toHaveBeenCalled();
            expect(result.current.fetchStatus).toBe('idle');
        });

        it('fetches the certificate by id', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: { id: 'c1', name: 'x' } }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useCertificate('c1'), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/certificates/c1');
            expect(result.current.data).toEqual({ id: 'c1', name: 'x' });
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useCertificate('c1'), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to load certificate');
        });
    });

    describe('useCertificateContent', () => {
        it('does not fetch when id is undefined', () => {
            const { wrapper } = createWrapper();
            renderHook(() => useCertificateContent(undefined), { wrapper });
            expect(fetch).not.toHaveBeenCalled();
        });

        it('omits the versionId query string when not provided', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: { body: 'b', privateKey: 'k' } }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useCertificateContent('c1'), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/certificates/c1/content');
        });

        it('appends an encoded versionId query string when provided', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: { body: 'b', privateKey: 'k' } }));
            const { wrapper } = createWrapper();
            renderHook(() => useCertificateContent('c1', 'v 1'), { wrapper });
            await waitFor(() =>
                expect(fetch).toHaveBeenCalledWith('/api/certificates/c1/content?versionId=v%201'),
            );
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useCertificateContent('c1'), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to load certificate material');
        });
    });

    describe('useCertificateVersions', () => {
        it('does not fetch when id is undefined', () => {
            const { wrapper } = createWrapper();
            renderHook(() => useCertificateVersions(undefined), { wrapper });
            expect(fetch).not.toHaveBeenCalled();
        });

        it('fetches versions for the certificate', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: [{ id: 'v1' }] }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useCertificateVersions('c1'), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/certificates/c1/versions');
            expect(result.current.data).toEqual([{ id: 'v1' }]);
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useCertificateVersions('c1'), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to load versions');
        });
    });

    describe('useCertificateAccounts', () => {
        it('does not fetch when id is undefined', () => {
            const { wrapper } = createWrapper();
            renderHook(() => useCertificateAccounts(undefined), { wrapper });
            expect(fetch).not.toHaveBeenCalled();
        });

        it('unwraps data.accounts', async () => {
            (fetch as Mock).mockResolvedValue(
                jsonRes({ success: true, data: { accounts: [{ accountId: 'a1' }] } }),
            );
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useCertificateAccounts('c1'), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(result.current.data).toEqual([{ accountId: 'a1' }]);
        });

        it('defaults to an empty array when data.accounts is missing', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: {} }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useCertificateAccounts('c1'), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(result.current.data).toEqual([]);
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useCertificateAccounts('c1'), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to load accounts');
        });
    });

    describe('useCertificateAccountDetail', () => {
        it('does not fetch when either id is undefined', () => {
            const { wrapper } = createWrapper();
            renderHook(() => useCertificateAccountDetail(undefined, 'a1'), { wrapper });
            renderHook(() => useCertificateAccountDetail('c1', undefined), { wrapper });
            expect(fetch).not.toHaveBeenCalled();
        });

        it('fetches the account detail for a certificate', async () => {
            (fetch as Mock).mockResolvedValue(
                jsonRes({ success: true, data: { certificate: {}, account: { accountId: 'a1' } } }),
            );
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useCertificateAccountDetail('c1', 'a1'), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/certificates/c1/accounts/a1');
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useCertificateAccountDetail('c1', 'a1'), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Certificate or account not found');
        });
    });

    describe('useCertificateExecutions', () => {
        it('does not fetch when id is undefined', () => {
            const { wrapper } = createWrapper();
            renderHook(() => useCertificateExecutions(undefined), { wrapper });
            expect(fetch).not.toHaveBeenCalled();
        });

        it('defaults limit to 100 and forwards a custom limit', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: [] }));
            const { wrapper } = createWrapper();
            renderHook(() => useCertificateExecutions('c1'), { wrapper });
            await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/certificates/c1/executions?limit=100'));

            (fetch as Mock).mockClear();
            renderHook(() => useCertificateExecutions('c1', 25), { wrapper: createWrapper().wrapper });
            await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/certificates/c1/executions?limit=25'));
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useCertificateExecutions('c1'), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to load execution history');
        });
    });

    describe('useUploadCertificate', () => {
        it('POSTs the input and invalidates certificates.all on success', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: { id: 'c1' } }));
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useUploadCertificate(), { wrapper });

            const input = { name: 'n', domainName: 'd', body: 'b', privateKey: 'k' };
            result.current.mutate(input);
            await waitFor(() => expect(result.current.isSuccess).toBe(true));

            expect(fetch).toHaveBeenCalledWith('/api/certificates', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(input),
            });
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.certificates.all });
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useUploadCertificate(), { wrapper });
            result.current.mutate({ name: 'n', domainName: 'd', body: 'b', privateKey: 'k' });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to upload certificate');
        });
    });

    describe('useDeleteCertificate', () => {
        it('DELETEs by id and invalidates on success', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true }));
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useDeleteCertificate(), { wrapper });
            result.current.mutate('c1');
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/certificates/c1', { method: 'DELETE' });
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.certificates.all });
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useDeleteCertificate(), { wrapper });
            result.current.mutate('c1');
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to delete certificate');
        });
    });

    describe('useDiscoverCertificate', () => {
        it('POSTs to discover and invalidates on success', async () => {
            (fetch as Mock).mockResolvedValue(
                jsonRes({ success: true, data: { status: 'success', matched: 1, errored: 0, skipped: 0, targets: 1, accountsScanned: 1 } }),
            );
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useDiscoverCertificate(), { wrapper });
            result.current.mutate('c1');
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/certificates/c1/discover', { method: 'POST' });
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.certificates.all });
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useDiscoverCertificate(), { wrapper });
            result.current.mutate('c1');
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Discovery failed');
        });
    });

    describe('useDeployCertificate', () => {
        it('POSTs accountId/region/force and invalidates on success', async () => {
            (fetch as Mock).mockResolvedValue(
                jsonRes({ success: true, data: { certificateArn: 'arn', accountId: 'a1', region: 'us-east-1' } }),
            );
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useDeployCertificate(), { wrapper });
            result.current.mutate({ certId: 'c1', accountId: 'a1', region: 'us-east-1', force: true });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/certificates/c1/deploy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ accountId: 'a1', region: 'us-east-1', force: true }),
            });
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.certificates.all });
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useDeployCertificate(), { wrapper });
            result.current.mutate({ certId: 'c1', accountId: 'a1' });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to deploy certificate');
        });
    });

    describe('useReimportCertificate', () => {
        it('resolves a partial/failed AWS outcome as long as data is present and status < 500', async () => {
            (fetch as Mock).mockResolvedValue(
                jsonRes(
                    { success: false, data: { accountId: 'a1', version: 2, perRegion: [], status: 'partial' } },
                    { ok: false, status: 207 },
                ),
            );
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useReimportCertificate(), { wrapper });
            result.current.mutate({ certId: 'c1', accountId: 'a1' });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(result.current.data?.data.status).toBe('partial');
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.certificates.all });
        });

        it('throws on a 5xx transport error', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ error: 'server exploded' }, { ok: false, status: 500 }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useReimportCertificate(), { wrapper });
            result.current.mutate({ certId: 'c1', accountId: 'a1' });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('server exploded');
        });

        it('throws when data is absent even below 500', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false, status: 404 }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useReimportCertificate(), { wrapper });
            result.current.mutate({ certId: 'c1', accountId: 'a1' });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Reimport failed');
        });
    });

    describe('useUploadVersion', () => {
        it('strips certId from the request body and invalidates on success', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: { id: 'v1' } }));
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useUploadVersion(), { wrapper });
            result.current.mutate({ certId: 'c1', body: 'b', privateKey: 'k', activate: true });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));

            expect(fetch).toHaveBeenCalledWith('/api/certificates/c1/versions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ body: 'b', privateKey: 'k', activate: true }),
            });
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.certificates.all });
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useUploadVersion(), { wrapper });
            result.current.mutate({ certId: 'c1', body: 'b', privateKey: 'k' });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to upload version');
        });
    });

    describe('useActivateVersion', () => {
        it('POSTs to activate and invalidates on success', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true }));
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useActivateVersion(), { wrapper });
            result.current.mutate({ certId: 'c1', versionId: 'v1' });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/certificates/c1/versions/v1/activate', { method: 'POST' });
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.certificates.all });
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useActivateVersion(), { wrapper });
            result.current.mutate({ certId: 'c1', versionId: 'v1' });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to activate version');
        });
    });

    describe('useDeleteVersion', () => {
        it('DELETEs the version and invalidates on success', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true }));
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useDeleteVersion(), { wrapper });
            result.current.mutate({ certId: 'c1', versionId: 'v1' });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/certificates/c1/versions/v1', { method: 'DELETE' });
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.certificates.all });
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useDeleteVersion(), { wrapper });
            result.current.mutate({ certId: 'c1', versionId: 'v1' });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to delete version');
        });
    });
});
