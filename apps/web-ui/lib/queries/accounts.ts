'use client';

/**
 * TanStack Query hooks for the Accounts domain.
 *
 * These wrap the existing `ClientAccountService` (which owns the fetch + API
 * envelope handling) and add caching, dedup, and automatic cache invalidation
 * on mutation. This is the REFERENCE PATTERN for migrating other domains
 * (schedules, audit, inventory, …) off raw fetch + useEffect.
 *
 * Pattern:
 *   - reads  -> useQuery keyed via queryKeys.<domain>
 *   - writes -> useMutation that invalidates the relevant keys onSuccess
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClientAccountService } from '@/lib/client-account-service';
import { queryKeys } from '@/lib/queries/query-keys';
import type { UIAccount } from '@/lib/types';

export interface AccountFilters {
    statusFilter?: string;
    connectionFilter?: string;
    searchTerm?: string;
    limit?: number;
    page?: number;
}

/** List accounts with optional filters. Returns { accounts, totalCount }. */
export function useAccounts(filters?: AccountFilters) {
    return useQuery({
        queryKey: queryKeys.accounts.list(filters),
        queryFn: () => ClientAccountService.getAccounts(filters),
        placeholderData: (prev) => prev, // keep prior page visible while refetching (smooth pagination)
    });
}

/** Fetch a single account by id. Disabled when no id is provided. */
export function useAccount(accountId: string | undefined) {
    return useQuery({
        queryKey: queryKeys.accounts.detail(accountId ?? ''),
        queryFn: () => ClientAccountService.getAccount(accountId as string),
        enabled: !!accountId,
    });
}

type CreateAccountInput = Parameters<typeof ClientAccountService.createAccount>[0];

export function useCreateAccount() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: (data: CreateAccountInput) => ClientAccountService.createAccount(data),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: queryKeys.accounts.all });
        },
    });
}

type UpdateAccountInput = Parameters<typeof ClientAccountService.updateAccount>[1];

export function useUpdateAccount() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: ({ accountId, data }: { accountId: string; data: UpdateAccountInput }) =>
            ClientAccountService.updateAccount(accountId, data),
        onSuccess: (_res, { accountId }) => {
            qc.invalidateQueries({ queryKey: queryKeys.accounts.lists() });
            qc.invalidateQueries({ queryKey: queryKeys.accounts.detail(accountId) });
            qc.invalidateQueries({ queryKey: queryKeys.accounts.stats() });
        },
    });
}

export function useDeleteAccount() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: (accountId: string) => ClientAccountService.deleteAccount(accountId),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: queryKeys.accounts.all });
        },
    });
}

/** On-demand resource scan for an account (no caching — always fresh). */
export function useScanResources() {
    return useMutation({
        mutationFn: (accountId: string) => ClientAccountService.scanResources(accountId),
    });
}

export type { UIAccount };
