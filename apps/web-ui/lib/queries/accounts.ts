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
import { useAbilityMeta, useCan, useDenialReason } from '@/hooks/use-can';
import type { UIAccount } from '@/lib/types';

export interface AccountFilters {
    statusFilter?: string;
    connectionFilter?: string;
    searchTerm?: string;
    limit?: number;
    page?: number;
}

interface AccountsListData {
    accounts: UIAccount[];
    totalCount: number;
}

/**
 * List accounts with optional filters. Returns { accounts, totalCount }.
 * Pass `options.initialData` to seed the cache from server-rendered data
 * (avoids a loading flash on first paint). initialData only applies to the
 * matching query key, so only pass it when filters equal the server's.
 */
export function useAccounts(
    filters?: AccountFilters,
    options?: { initialData?: AccountsListData },
) {
    const { isLoaded } = useAbilityMeta();
    const canRead = useCan('read', 'Account');

    return useQuery({
        queryKey: queryKeys.accounts.list(filters),
        queryFn: () => ClientAccountService.getAccounts(filters),
        placeholderData: (prev) => prev, // keep prior page visible while refetching (smooth pagination)
        initialData: options?.initialData,
        /**
         * ── GATED AT THE SOURCE, NOT AT THE CALL SITES ──────────────────────
         * This hook is consumed by pages a caller can reach WITHOUT `read
         * Account`: right-sizing (Inventory), spot-guard (Schedules),
         * deploy-certificate and member-attributes (Settings). Each of those
         * fired a request that /api/accounts correctly refused, and the 403
         * surfaced as a thrown query — a Console Error in dev and a broken panel
         * in production, for a permission working exactly as designed.
         *
         * A disabled query is the right shape for that: `data` is undefined and
         * v5 reports `isLoading` false (it is `isPending && isFetching`, and a
         * disabled query never fetches), so callers render their empty state
         * rather than spinning forever. Use `useAccountOptions` where the reason
         * should be shown to the user.
         */
        enabled: isLoaded && canRead,
    });
}

/**
 * The account list as a PICKER needs it: gated, never throwing, and able to say
 * why it is empty.
 *
 * ── WHY THIS EXISTS RATHER THAN A CHECK AT EACH CALL SITE ────────────────────
 * Five places wanted "the accounts I can pick from" — the inventory filter, the
 * schedule form, the deep-agent selector, the Mission Control composer, and the
 * accounts page itself — and four of them hand-rolled the same
 * useState + useEffect + ClientAccountService.getAccounts + catch(console.error).
 *
 * A role that can read Inventory or create Schedules but NOT read Accounts is
 * perfectly ordinary, and every one of those sites then requested a list it was
 * never allowed to see: /api/accounts answered 403, the service threw, and the
 * catch logged it — which Next's dev overlay renders as a Console Error, so
 * correct enforcement looked like a crash. Fixing them one at a time just moved
 * the error to the next caller, which is exactly what happened.
 *
 * The permission is asked ONCE, here, and the request is not issued when the
 * answer is no. `authorize()` on the route plus its row filter remain the
 * boundary; this only avoids a request that was always going to be refused.
 */
export function useAccountOptions(filters?: AccountFilters): {
    accounts: UIAccount[];
    isLoading: boolean;
    /** Human-readable reason, or null when permitted. Render it; don't swallow it. */
    denied: string | null;
} {
    const { isLoaded } = useAbilityMeta();
    const canRead = useCan('read', 'Account');
    const reason = useDenialReason('read', 'Account');

    // useAccounts already carries the `enabled` gate; this adds the reason and a
    // picker-shaped return so call sites need no ability wiring of their own.
    const query = useAccounts(filters);

    return {
        accounts: query.data?.accounts ?? [],
        // "Denied" is a settled answer, not a pending one — reporting it as
        // loading would leave every picker spinning on a question already
        // answered. Before the rules arrive, loading IS the honest answer.
        isLoading: isLoaded ? (canRead && query.isLoading) : true,
        denied: isLoaded && !canRead ? reason : null,
    };
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
