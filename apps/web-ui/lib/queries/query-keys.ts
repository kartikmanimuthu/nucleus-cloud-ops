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
    rightSizing: {
        all: ['right-sizing'] as const,
        recommendations: (filters?: unknown) =>
            [...queryKeys.rightSizing.all, 'recommendations', filters ?? {}] as const,
        summary: () => [...queryKeys.rightSizing.all, 'summary'] as const,
    },
    certificates: {
        all: ['certificates'] as const,
        lists: () => [...queryKeys.certificates.all, 'list'] as const,
        list: (filters?: unknown) => [...queryKeys.certificates.lists(), filters ?? {}] as const,
        details: () => [...queryKeys.certificates.all, 'detail'] as const,
        detail: (id: string) => [...queryKeys.certificates.details(), id] as const,
        versions: (id: string) => [...queryKeys.certificates.detail(id), 'versions'] as const,
        accounts: (id: string) => [...queryKeys.certificates.detail(id), 'accounts'] as const,
        accountDetail: (id: string, accountId: string) =>
            [...queryKeys.certificates.detail(id), 'account', accountId] as const,
        executions: (id: string) => [...queryKeys.certificates.detail(id), 'executions'] as const,
        content: (id: string, versionId?: string) =>
            [...queryKeys.certificates.detail(id), 'content', versionId ?? 'active'] as const,
    },
    kbChat: {
        all: ['kb-chat'] as const,
        sessions: () => [...queryKeys.kbChat.all, 'sessions'] as const,
        messages: (sessionId: string) => [...queryKeys.kbChat.all, 'messages', sessionId] as const,
    },
    agentMemories: {
        all: ['agent-memories'] as const,
        lists: () => [...queryKeys.agentMemories.all, 'list'] as const,
        list: (filters?: unknown) => [...queryKeys.agentMemories.lists(), filters ?? {}] as const,
        details: () => [...queryKeys.agentMemories.all, 'detail'] as const,
        detail: (id: string) => [...queryKeys.agentMemories.details(), id] as const,
    },
} as const;
