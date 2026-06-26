/**
 * Centralized TanStack Query key factory.
 *
 * One source of truth for every query key in the app so invalidation is
 * predictable and typo-proof. Each domain exposes:
 *   - `all`     — root key for the domain (invalidate everything in it)
 *   - `lists()` — key prefix for all list queries
 *   - `list(filters)` — a specific filtered list
 *   - `details()` / `detail(id)` — single-entity keys
 *
 * Usage:
 *   useQuery({ queryKey: queryKeys.accounts.list(filters), ... })
 *   queryClient.invalidateQueries({ queryKey: queryKeys.accounts.all })
 */
export const queryKeys = {
    accounts: {
        all: ['accounts'] as const,
        lists: () => [...queryKeys.accounts.all, 'list'] as const,
        list: (filters?: unknown) => [...queryKeys.accounts.lists(), filters ?? {}] as const,
        details: () => [...queryKeys.accounts.all, 'detail'] as const,
        detail: (id: string) => [...queryKeys.accounts.details(), id] as const,
        stats: () => [...queryKeys.accounts.all, 'stats'] as const,
        scan: (id: string) => [...queryKeys.accounts.all, 'scan', id] as const,
    },
    schedules: {
        all: ['schedules'] as const,
        lists: () => [...queryKeys.schedules.all, 'list'] as const,
        list: (filters?: unknown) => [...queryKeys.schedules.lists(), filters ?? {}] as const,
        details: () => [...queryKeys.schedules.all, 'detail'] as const,
        detail: (id: string) => [...queryKeys.schedules.details(), id] as const,
    },
    audit: {
        all: ['audit'] as const,
        lists: () => [...queryKeys.audit.all, 'list'] as const,
        list: (filters?: unknown) => [...queryKeys.audit.lists(), filters ?? {}] as const,
        stats: (filters?: unknown) => [...queryKeys.audit.all, 'stats', filters ?? {}] as const,
    },
} as const;
