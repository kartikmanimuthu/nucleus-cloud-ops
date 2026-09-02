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
        executions: (id: string, filters?: unknown) =>
            [...queryKeys.schedules.detail(id), 'executions', filters ?? {}] as const,
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
        details: () => [...queryKeys.rightSizing.all, 'detail'] as const,
        detail: (id: string) => [...queryKeys.rightSizing.details(), id] as const,
    },
    scalingAudit: {
        all: ['scaling-audit'] as const,
        resources: (filters?: unknown) => [...queryKeys.scalingAudit.all, 'resources', filters ?? {}] as const,
        events: (filters?: unknown) => [...queryKeys.scalingAudit.all, 'events', filters ?? {}] as const,
        details: () => [...queryKeys.scalingAudit.all, 'detail'] as const,
        detail: (id: string) => [...queryKeys.scalingAudit.details(), id] as const,
        summary: () => [...queryKeys.scalingAudit.all, 'summary'] as const,
        runs: (filters?: unknown) => [...queryKeys.scalingAudit.all, 'runs', filters ?? {}] as const,
        coverage: () => [...queryKeys.scalingAudit.all, 'coverage'] as const,
    },
    networkLinks: {
        all: ['network-links'] as const,
        report: (filters?: unknown) => [...queryKeys.networkLinks.all, 'report', filters ?? {}] as const,
    },
    capacityPlanning: {
        all: ['capacity-planning'] as const,
        summary: (filters?: unknown) => [...queryKeys.capacityPlanning.all, 'summary', filters ?? {}] as const,
        breaches: (filters?: unknown) => [...queryKeys.capacityPlanning.all, 'breaches', filters ?? {}] as const,
        runs: (filters?: unknown) => [...queryKeys.capacityPlanning.all, 'runs', filters ?? {}] as const,
        resource: (resourceId: string, filters?: unknown) =>
            [...queryKeys.capacityPlanning.all, 'resource', resourceId, filters ?? {}] as const,
    },
    spotGuard: {
        facets: () => [...queryKeys.spotGuard.all, 'facets'] as const,
        all: ['spot-guard'] as const,
        services: (filters?: unknown) => [...queryKeys.spotGuard.all, 'services', filters ?? {}] as const,
        details: () => [...queryKeys.spotGuard.all, 'detail'] as const,
        detail: (id: string) => [...queryKeys.spotGuard.details(), id] as const,
        eligible: (filters?: unknown) => [...queryKeys.spotGuard.all, 'eligible', filters ?? {}] as const,
        events: (filters?: unknown) => [...queryKeys.spotGuard.all, 'events', filters ?? {}] as const,
        summary: () => [...queryKeys.spotGuard.all, 'summary'] as const,
        report: (range?: unknown) => [...queryKeys.spotGuard.all, 'report', range ?? {}] as const,
        settings: () => [...queryKeys.spotGuard.all, 'settings'] as const,
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
    subagents: {
        all: ['subagents'] as const,
        byThread: (threadId: string) => [...queryKeys.subagents.all, 'thread', threadId] as const,
    },
    kbChat: {
        all: ['kb-chat'] as const,
        sessions: () => [...queryKeys.kbChat.all, 'sessions'] as const,
        messages: (sessionId: string) => [...queryKeys.kbChat.all, 'messages', sessionId] as const,
    },
    mcpServers: {
        all: ['mcp-servers'] as const,
        config: (apiPath: string) => [...queryKeys.mcpServers.all, apiPath] as const,
    },
    agentOps: {
        all: ['agent-ops'] as const,
        lists: () => [...queryKeys.agentOps.all, 'list'] as const,
        list: (filters?: unknown) => [...queryKeys.agentOps.lists(), filters ?? {}] as const,
        details: () => [...queryKeys.agentOps.all, 'detail'] as const,
        detail: (runId: string) => [...queryKeys.agentOps.details(), runId] as const,
        scheduledTasks: {
            all: ['agent-ops', 'scheduled-tasks'] as const,
            lists: () => [...queryKeys.agentOps.scheduledTasks.all, 'list'] as const,
            list: (filters?: unknown) => [...queryKeys.agentOps.scheduledTasks.lists(), filters ?? {}] as const,
            runs: (taskId: string, filters?: unknown) =>
                [...queryKeys.agentOps.scheduledTasks.all, 'runs', taskId, filters ?? {}] as const,
        },
    },
    agentMemories: {
        all: ['agent-memories'] as const,
        lists: () => [...queryKeys.agentMemories.all, 'list'] as const,
        list: (filters?: unknown) => [...queryKeys.agentMemories.lists(), filters ?? {}] as const,
        details: () => [...queryKeys.agentMemories.all, 'detail'] as const,
        detail: (id: string) => [...queryKeys.agentMemories.details(), id] as const,
    },
    skills: {
        all: ['skills'] as const,
        lists: () => [...queryKeys.skills.all, 'list'] as const,
        list: (all?: boolean) => [...queryKeys.skills.lists(), { all: !!all }] as const,
        details: () => [...queryKeys.skills.all, 'detail'] as const,
        detail: (id: string) => [...queryKeys.skills.details(), id] as const,
    },
    threads: {
        all: ['threads'] as const,
        lists: () => [...queryKeys.threads.all, 'list'] as const,
    },
    /**
     * Per-tenant AI Ops settings — the sub-agent budget and the feature flags.
     *
     * `lib/queries/aiops-settings.ts` has referenced this domain since it landed,
     * but the domain itself was never added here, so `queryKeys.aiopsSettings`
     * was `undefined` and every render of RunRail (via useAiopsSubagentSettings)
     * threw `Cannot read properties of undefined (reading 'subagents')` — taking
     * the whole /app/agent page down with it.
     */
    aiopsSettings: {
        all: ['aiops-settings'] as const,
        subagents: () => [...queryKeys.aiopsSettings.all, 'subagents'] as const,
    },
    /** The caller's own compiled ability. Invalidated by every RBAC mutation. */
    ability: {
        all: ['ability'] as const,
        me: () => [...queryKeys.ability.all, 'me'] as const,
    },
    rbac: {
        all: ['rbac'] as const,
        registry: () => [...queryKeys.rbac.all, 'registry'] as const,
        modules: () => [...queryKeys.rbac.all, 'modules'] as const,
        actions: () => [...queryKeys.rbac.all, 'actions'] as const,
        subjects: () => [...queryKeys.rbac.all, 'subjects'] as const,
        roles: () => [...queryKeys.rbac.all, 'roles'] as const,
        role: (id: string) => [...queryKeys.rbac.roles(), id] as const,
        routes: () => [...queryKeys.rbac.all, 'routes'] as const,
        unmapped: () => [...queryKeys.rbac.all, 'unmapped'] as const,
        denials: (filters?: unknown) => [...queryKeys.rbac.all, 'denials', filters ?? {}] as const,
        ledger: (filters?: unknown) => [...queryKeys.rbac.all, 'ledger', filters ?? {}] as const,
        principalAttributes: () => [...queryKeys.rbac.all, 'principal-attrs'] as const,
        userAttributes: (memberId: string) => [...queryKeys.rbac.all, 'user-attrs', memberId] as const,
    },
    dashboard: {
        all: ['dashboard'] as const,
        hero: (range: string) => [...queryKeys.dashboard.all, 'hero', range] as const,
        actionCenter: (range: string) => [...queryKeys.dashboard.all, 'action-center', range] as const,
        coverage: () => [...queryKeys.dashboard.all, 'coverage'] as const,
        costAutomation: (range: string) => [...queryKeys.dashboard.all, 'cost-automation', range] as const,
        agentActivity: (range: string) => [...queryKeys.dashboard.all, 'agent-activity', range] as const,
        inventory: () => [...queryKeys.dashboard.all, 'inventory'] as const,
        audit: (range: string) => [...queryKeys.dashboard.all, 'audit', range] as const,
    },
    resourceGraph: {
        all: ['resourceGraph'] as const,
        details: () => [...queryKeys.resourceGraph.all, 'detail'] as const,
        detail: (resourceType: string, resourceId: string) =>
            [...queryKeys.resourceGraph.details(), resourceType, resourceId] as const,
        summary: (accountId?: string) =>
            [...queryKeys.resourceGraph.all, 'summary', accountId ?? 'all'] as const,
        byType: (resourceType: string, accountId?: string) =>
            [...queryKeys.resourceGraph.all, 'byType', resourceType, accountId ?? 'all'] as const,
    },
} as const;
