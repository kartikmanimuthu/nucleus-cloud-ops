// @vitest-environment jsdom
//
// Two Important-severity gaps called out in review, both real client logic:
//
// 1. RegistryRequestError.isConfirmable — the status→boolean mapping every
//    mutation dialog on the two admin screens (permissions, modules) branches
//    on to decide "confirm and retry" vs. a plain error toast. Tested directly
//    on the class, no rendering needed.
// 2. readJson's non-JSON-body handling — `res.json().catch(() => null)` is
//    what stands between "server returns a 500 with no body" and an unhandled
//    rejection reaching the caller. readJson itself isn't exported, so it's
//    exercised through useDeletePermission, the simplest mutation hook here.
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, afterEach, beforeEach, type Mock } from 'vitest';

import {
    RegistryRequestError,
    useAdminRegistry,
    useDeletePermission,
    useCreatePermission,
    useUpdatePermission,
    useCreateModule,
    useUpdateModule,
    useDeleteModule,
} from './rbac-registry';
import { queryKeys } from './query-keys';

describe('RegistryRequestError', () => {
    it('is confirmable only for a 409', () => {
        expect(new RegistryRequestError('conflict', 409).isConfirmable).toBe(true);
    });

    it.each([403, 400, 500])('is not confirmable for a %d', (status) => {
        expect(new RegistryRequestError('nope', status).isConfirmable).toBe(false);
    });

    it('preserves message and status', () => {
        const err = new RegistryRequestError('Cannot delete a built-in permission.', 403);
        expect(err.message).toBe('Cannot delete a built-in permission.');
        expect(err.status).toBe(403);
    });

    it('sets its name to RegistryRequestError', () => {
        expect(new RegistryRequestError('msg', 409).name).toBe('RegistryRequestError');
    });
});

function wrapper({ children }: { children: React.ReactNode }) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    return React.createElement(QueryClientProvider, { client }, children);
}

describe('readJson — exercised through useDeletePermission', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('degrades a non-JSON failure body to a RegistryRequestError instead of an unhandled rejection', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: false,
                status: 500,
                json: () => Promise.reject(new Error('not json')),
            })
        );

        const { result } = renderHook(() => useDeletePermission(), { wrapper });

        result.current.mutate({ id: 'perm-1' });

        await waitFor(() => expect(result.current.isError).toBe(true));

        expect(result.current.error).toBeInstanceOf(RegistryRequestError);
        expect((result.current.error as RegistryRequestError).status).toBe(500);
    });
});

const jsonRes = (body: unknown, opts: { ok?: boolean; status?: number } = {}) => ({
    ok: opts.ok ?? true,
    status: opts.status ?? (opts.ok === false ? 400 : 200),
    json: () => Promise.resolve(body),
});

describe('registry queries and mutations', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    describe('useAdminRegistry', () => {
        it('fetches the registry', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: { modules: [], actions: [], subjects: [] } }));
            const { result } = renderHook(() => useAdminRegistry(), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/settings/rbac/registry');
        });

        it('throws a RegistryRequestError carrying the response status on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false, error: 'nope' }, { ok: false, status: 403 }));
            const { result } = renderHook(() => useAdminRegistry(), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            const err = result.current.error as RegistryRequestError;
            expect(err).toBeInstanceOf(RegistryRequestError);
            expect(err.status).toBe(403);
            expect(err.isConfirmable).toBe(false);
        });
    });

    /** Every registry mutation shares this invalidation contract. */
    function expectTripleInvalidate(invalidateSpy: ReturnType<typeof vi.spyOn>) {
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.rbac.all });
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.ability.all });
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['settings', 'roles'] });
    }

    describe('useCreatePermission', () => {
        it('POSTs the input and invalidates rbac.all, ability.all, and settings/roles', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: { id: 'p1' } }));
            const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const localWrapper = ({ children }: { children: React.ReactNode }) =>
                React.createElement(QueryClientProvider, { client: queryClient }, children);
            const { result } = renderHook(() => useCreatePermission(), { wrapper: localWrapper });
            result.current.mutate({ key: 'Account.read', label: 'Read accounts' });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));

            expect(fetch).toHaveBeenCalledWith('/api/settings/rbac/permissions', expect.objectContaining({
                method: 'POST', body: JSON.stringify({ key: 'Account.read', label: 'Read accounts' }),
            }));
            expectTripleInvalidate(invalidateSpy);
        });

        it('surfaces a 409 as a confirmable RegistryRequestError', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false, error: 'in use' }, { ok: false, status: 409 }));
            const { result } = renderHook(() => useCreatePermission(), { wrapper });
            result.current.mutate({ key: 'k', label: 'l' });
            await waitFor(() => expect(result.current.isError).toBe(true));
            const err = result.current.error as RegistryRequestError;
            expect(err.isConfirmable).toBe(true);
            expect(err.message).toBe('in use');
        });
    });

    describe('useUpdatePermission', () => {
        it('strips id/reason handling and PUTs to /:id', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: {} }));
            const { result } = renderHook(() => useUpdatePermission(), { wrapper });
            result.current.mutate({ id: 'p1', key: 'k', label: 'renamed', reason: 'typo fix' });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/settings/rbac/permissions/p1', expect.objectContaining({
                method: 'PUT', body: JSON.stringify({ key: 'k', label: 'renamed', reason: 'typo fix' }),
            }));
        });

        it('throws with the fallback message when the server omits an error', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false, status: 400 }));
            const { result } = renderHook(() => useUpdatePermission(), { wrapper });
            result.current.mutate({ id: 'p1', key: 'k', label: 'l' });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to update the permission.');
        });
    });

    describe('useCreateModule', () => {
        it('POSTs the module input and returns the write result', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: { id: 'm1', materializedRules: 2, revokedRules: 0 } }));
            const { result } = renderHook(() => useCreateModule(), { wrapper });
            result.current.mutate({ key: 'inventory', label: 'Inventory', actionKeys: ['read'], subjectKeys: ['Account'] });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/settings/rbac/modules', expect.objectContaining({ method: 'POST' }));
            expect(result.current.data).toEqual({ id: 'm1', materializedRules: 2, revokedRules: 0 });
        });
    });

    describe('useUpdateModule', () => {
        it('PUTs to /:id with the id stripped from the body', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: { id: 'm1', materializedRules: 0, revokedRules: 1 } }));
            const { result } = renderHook(() => useUpdateModule(), { wrapper });
            result.current.mutate({ id: 'm1', key: 'inventory', label: 'Inventory', actionKeys: [], subjectKeys: [], force: true });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/settings/rbac/modules/m1', expect.objectContaining({
                method: 'PUT', body: JSON.stringify({ key: 'inventory', label: 'Inventory', actionKeys: [], subjectKeys: [], force: true }),
            }));
        });
    });

    describe('useDeleteModule', () => {
        it('DELETEs /:id with the reason in the body', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: {} }));
            const { result } = renderHook(() => useDeleteModule(), { wrapper });
            result.current.mutate({ id: 'm1', reason: 'unused' });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/settings/rbac/modules/m1', expect.objectContaining({
                method: 'DELETE', body: JSON.stringify({ reason: 'unused' }),
            }));
        });

        it('sends an empty-reason body when no reason is given', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: {} }));
            const { result } = renderHook(() => useDeleteModule(), { wrapper });
            result.current.mutate({ id: 'm1' } as any);
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/settings/rbac/modules/m1', expect.objectContaining({
                body: '{}',
            }));
        });
    });
});
