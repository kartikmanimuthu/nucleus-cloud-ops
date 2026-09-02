// @vitest-environment jsdom
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

import { useRoles, useSaveRole, useDeleteRole } from './roles';

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
const rolesKey = ['settings', 'roles'] as const;

describe('roles queries', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => vi.unstubAllGlobals());

    describe('useRoles', () => {
        it('returns predefined and custom roles', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: { predefined: [{ id: 'p1' }], custom: [{ id: 'c1' }] } }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useRoles(), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(result.current.data).toEqual({ predefined: [{ id: 'p1' }], custom: [{ id: 'c1' }] });
        });

        it('defaults both lists to empty arrays when the body omits them', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true, data: {} }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useRoles(), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(result.current.data).toEqual({ predefined: [], custom: [] });
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useRoles(), { wrapper });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to load roles.');
        });
    });

    describe('useSaveRole', () => {
        it('POSTs to the collection when no id is given (create)', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true }));
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useSaveRole(), { wrapper });
            result.current.mutate({ name: 'n', permissions: {} as any, overrides: {} as any });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/settings/roles', expect.objectContaining({ method: 'POST' }));
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: rolesKey });
        });

        it('PUTs to /:id when an id is given (update)', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSaveRole(), { wrapper });
            result.current.mutate({ id: 'r1', name: 'n', permissions: {} as any, overrides: {} as any });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/settings/roles/r1', expect.objectContaining({ method: 'PUT' }));
        });

        it('uses a create-specific fallback message when creating fails', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSaveRole(), { wrapper });
            result.current.mutate({ name: 'n', permissions: {} as any, overrides: {} as any });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to create role.');
        });

        it('uses an update-specific fallback message when updating fails', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useSaveRole(), { wrapper });
            result.current.mutate({ id: 'r1', name: 'n', permissions: {} as any, overrides: {} as any });
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to update role.');
        });
    });

    describe('useDeleteRole', () => {
        it('DELETEs by id and invalidates roles on success', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: true }));
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useDeleteRole(), { wrapper });
            result.current.mutate('r1');
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(fetch).toHaveBeenCalledWith('/api/settings/roles/r1', { method: 'DELETE' });
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: rolesKey });
        });

        it('throws with a fallback message on failure', async () => {
            (fetch as Mock).mockResolvedValue(jsonRes({ success: false }, { ok: false }));
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useDeleteRole(), { wrapper });
            result.current.mutate('r1');
            await waitFor(() => expect(result.current.isError).toBe(true));
            expect((result.current.error as Error).message).toBe('Failed to delete role.');
        });
    });
});
