// @vitest-environment jsdom
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/client-account-service', () => ({
    ClientAccountService: {
        getAccounts: vi.fn(),
        getAccount: vi.fn(),
        createAccount: vi.fn(),
        updateAccount: vi.fn(),
        deleteAccount: vi.fn(),
        scanResources: vi.fn(),
    },
}));
vi.mock('@/hooks/use-can', () => ({
    useAbilityMeta: vi.fn(),
    useCan: vi.fn(),
    useDenialReason: vi.fn(),
}));

import { ClientAccountService } from '@/lib/client-account-service';
import { useAbilityMeta, useCan, useDenialReason } from '@/hooks/use-can';
import {
    useAccounts,
    useAccountOptions,
    useAccount,
    useCreateAccount,
    useUpdateAccount,
    useDeleteAccount,
    useScanResources,
} from './accounts';
import { queryKeys } from '@/lib/queries/query-keys';

function createWrapper() {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client: queryClient }, children);
    return { queryClient, wrapper };
}

describe('accounts queries', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(useAbilityMeta).mockReturnValue({ isLoaded: true } as any);
        vi.mocked(useCan).mockReturnValue(true);
        vi.mocked(useDenialReason).mockReturnValue(null);
    });

    describe('useAccounts', () => {
        it('fetches when the ability has loaded and read is permitted', async () => {
            vi.mocked(ClientAccountService.getAccounts).mockResolvedValue({ accounts: [{ id: 'a1' }], totalCount: 1 } as any);
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useAccounts({ searchTerm: 'x' }), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(ClientAccountService.getAccounts).toHaveBeenCalledWith({ searchTerm: 'x' });
            expect(result.current.data).toEqual({ accounts: [{ id: 'a1' }], totalCount: 1 });
        });

        it('is disabled while the ability is still loading', () => {
            vi.mocked(useAbilityMeta).mockReturnValue({ isLoaded: false } as any);
            const { wrapper } = createWrapper();
            renderHook(() => useAccounts(), { wrapper });
            expect(ClientAccountService.getAccounts).not.toHaveBeenCalled();
        });

        it('is disabled when read Account is denied — no request fires', () => {
            vi.mocked(useCan).mockReturnValue(false);
            const { wrapper } = createWrapper();
            renderHook(() => useAccounts(), { wrapper });
            expect(ClientAccountService.getAccounts).not.toHaveBeenCalled();
        });

        it('seeds the cache from options.initialData', () => {
            const seed = { accounts: [{ id: 'seed' }], totalCount: 1 } as any;
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useAccounts(undefined, { initialData: seed }), { wrapper });
            expect(result.current.data).toEqual(seed);
        });
    });

    describe('useAccountOptions', () => {
        it('returns accounts and isLoading=false once resolved and permitted', async () => {
            vi.mocked(ClientAccountService.getAccounts).mockResolvedValue({ accounts: [{ id: 'a1' }], totalCount: 1 } as any);
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useAccountOptions(), { wrapper });
            await waitFor(() => expect(result.current.isLoading).toBe(false));
            expect(result.current.accounts).toEqual([{ id: 'a1' }]);
            expect(result.current.denied).toBeNull();
        });

        it('reports denied with a reason and does not fetch, instead of loading forever', () => {
            vi.mocked(useCan).mockReturnValue(false);
            vi.mocked(useDenialReason).mockReturnValue('Missing read:Account permission');
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useAccountOptions(), { wrapper });
            expect(result.current.isLoading).toBe(false);
            expect(result.current.denied).toBe('Missing read:Account permission');
            expect(result.current.accounts).toEqual([]);
            expect(ClientAccountService.getAccounts).not.toHaveBeenCalled();
        });

        it('reports isLoading=true while the ability itself has not loaded', () => {
            vi.mocked(useAbilityMeta).mockReturnValue({ isLoaded: false } as any);
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useAccountOptions(), { wrapper });
            expect(result.current.isLoading).toBe(true);
            expect(result.current.denied).toBeNull();
        });
    });

    describe('useAccount', () => {
        it('does not fetch when accountId is undefined', () => {
            const { wrapper } = createWrapper();
            renderHook(() => useAccount(undefined), { wrapper });
            expect(ClientAccountService.getAccount).not.toHaveBeenCalled();
        });

        it('fetches the account by id', async () => {
            vi.mocked(ClientAccountService.getAccount).mockResolvedValue({ id: 'a1' } as any);
            const { wrapper } = createWrapper();
            const { result } = renderHook(() => useAccount('a1'), { wrapper });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(ClientAccountService.getAccount).toHaveBeenCalledWith('a1');
        });
    });

    describe('mutations', () => {
        it('useCreateAccount invalidates accounts.all on success', async () => {
            vi.mocked(ClientAccountService.createAccount).mockResolvedValue({ id: 'a1' } as any);
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useCreateAccount(), { wrapper });
            result.current.mutate({ name: 'n' } as any);
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.accounts.all });
        });

        it('useUpdateAccount invalidates lists, the specific detail, and stats on success', async () => {
            vi.mocked(ClientAccountService.updateAccount).mockResolvedValue({ id: 'a1' } as any);
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useUpdateAccount(), { wrapper });
            result.current.mutate({ accountId: 'a1', data: { name: 'n' } as any });
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(ClientAccountService.updateAccount).toHaveBeenCalledWith('a1', { name: 'n' });
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.accounts.lists() });
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.accounts.detail('a1') });
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.accounts.stats() });
        });

        it('useDeleteAccount invalidates accounts.all on success', async () => {
            vi.mocked(ClientAccountService.deleteAccount).mockResolvedValue(undefined as any);
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useDeleteAccount(), { wrapper });
            result.current.mutate('a1');
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(ClientAccountService.deleteAccount).toHaveBeenCalledWith('a1');
            expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.accounts.all });
        });

        it('useScanResources does not touch the cache', async () => {
            vi.mocked(ClientAccountService.scanResources).mockResolvedValue({ scanned: 1 } as any);
            const { wrapper, queryClient } = createWrapper();
            const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
            const { result } = renderHook(() => useScanResources(), { wrapper });
            result.current.mutate('a1');
            await waitFor(() => expect(result.current.isSuccess).toBe(true));
            expect(ClientAccountService.scanResources).toHaveBeenCalledWith('a1');
            expect(invalidateSpy).not.toHaveBeenCalled();
        });
    });
});
