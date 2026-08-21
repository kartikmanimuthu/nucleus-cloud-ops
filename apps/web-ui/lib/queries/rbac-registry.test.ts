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
import { describe, expect, it, vi, afterEach } from 'vitest';

import { RegistryRequestError, useDeletePermission } from './rbac-registry';

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
