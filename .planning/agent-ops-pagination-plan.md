# Plan: Agent Ops Pagination / Sorting + Settings Cleanup

## Goals
1. Add server-side pagination and sorting to the **Agent Ops execution runs** grid.
2. Add server-side pagination and sorting to the **Scheduled Tasks** list.
3. Clean up the **Agent Ops Settings** dropdown so it only shows **Agent Defaults**; remove Slack, Jira, and MCP Servers entries.
4. Remove the 14 hardcoded default MCP servers — users add servers only when needed.

## Approach
Mirror the existing server-side table pattern used by **Agent Memory** (`DataTable` + `manualPagination` + `manualSorting`, offset-based `page`/`limit`, `sortBy`/`sortDir`, plus a `total` count). Keep the existing card/list row styling for Agent Ops runs and Scheduled Tasks rather than switching to a dense table, because the screenshots show a card-list UX. Pagination and sort controls sit above/below the list.

A critical side effect of pagination is that the top **stats cards** can no longer be computed from the current page. The list API will return a small `stats` envelope (total, in-progress, completed, failed for runs; active, paused, totalRuns for tasks) computed server-side across the filtered dataset.

## Files to modify

### Agent Ops runs
- `apps/web-ui/lib/agent-ops/types.ts` — extend `RunListQuery` with `page`, `limit`, `sortBy`, `sortDir`.
- `apps/web-ui/lib/db/repositories/agent-ops-run/interface.ts` — update `listRuns` return type to `{ runs, total }`.
- `apps/web-ui/lib/db/repositories/agent-ops-run/postgres.ts` — implement offset pagination, sort mapping, and `count()`.
- `apps/web-ui/lib/agent-ops/agent-ops-service.ts` — pass through new query fields; return `total`.
- `apps/web-ui/app/api/agent-ops/route.ts` — read `page`, `limit`, `sortBy`, `sortDir`; return `{ success, data, total, stats }`.
- `apps/web-ui/lib/queries/agent-ops.ts` — extend `RunListFilters` and `useAgentOpsRuns` to send new params and expose `{ runs, total, stats }`.
- `apps/web-ui/app/app/agent-ops/page.tsx` — add `DataTable`-driven pagination state + sort state, wire to query, render stats from API, keep card-list rows.

### Scheduled Tasks
- `apps/web-ui/lib/db/repositories/scheduled-task/interface.ts` — add `TaskListQuery` type and update `listScheduledTasks` signature to return `{ tasks, total, stats }`.
- `apps/web-ui/lib/db/repositories/scheduled-task/postgres.ts` — implement offset pagination, sorting, and stats.
- `apps/web-ui/lib/agent-ops/scheduled-task-service.ts` — update `listScheduledTasks` signature and return shape.
- `apps/web-ui/app/api/agent-ops/scheduled-tasks/route.ts` — read pagination/sort params; return `{ success, data, total, stats }`.
- Create `apps/web-ui/lib/queries/agent-ops-scheduled-tasks.ts` with `useScheduledTasks` hook (none exists today).
- `apps/web-ui/app/app/agent-ops/scheduled-tasks/page.tsx` — replace raw `fetch`/`useState` with TanStack Query hook + pagination/sort controls; render stats from API.

### Settings dropdown cleanup
- `apps/web-ui/app/app/agent-ops/page.tsx` — remove the Slack, Jira, and MCP Servers dropdown items; keep only **Agent Defaults**.

### Default MCP servers
- `apps/web-ui/lib/agent/mcp-config.ts` — change `DEFAULT_MCP_SERVERS` from 14 entries to `[]`. `defaultsToJson()` then returns `{ mcpServers: {} }` and `mergeConfigs()` returns only user-saved servers.

## Detailed implementation notes

### 1. Agent Ops runs pagination/sorting

#### Types
```ts
export interface RunListQuery {
    tenantId?: string;
    source?: TriggerSource;
    status?: AgentOpsStatus;
    page?: number;
    limit?: number;
    sortBy?: 'createdAt' | 'updatedAt' | 'status' | 'source' | 'taskDescription' | 'durationMs';
    sortDir?: 'asc' | 'desc';
}

export interface RunListStats {
    total: number;
    inProgress: number;
    completed: number;
    failed: number;
}
```

#### Repository (postgres.ts)
- `page` defaults to 1, `limit` defaults to 25.
- `skip = (page - 1) * limit`.
- `orderBy` maps `sortBy` to the Prisma column; default `{ createdAt: 'desc' }`.
- Run `Promise.all([count({ where }), findMany({ where, orderBy, skip, take: limit })])`.
- Return `{ runs, total }`.

#### API route
- Parse `page`, `limit`, `sortBy`, `sortDir` from query params.
- Call service, then compute stats from the full result set (or let the repository return stats in one query).
- Return `{ success: true, data: runs, total, stats }`.

#### Query hook
```ts
export interface RunListFilters {
    source?: string;
    status?: string;
    page?: number;
    limit?: number;
    sortBy?: RunListQuery['sortBy'];
    sortDir?: 'asc' | 'desc';
}

export function useAgentOpsRuns(filters: RunListFilters = {}) {
    return useQuery({
        queryKey: queryKeys.agentOps.list(filters),
        queryFn: async () => {
            const params = new URLSearchParams();
            params.set('page', String(filters.page ?? 1));
            params.set('limit', String(filters.limit ?? 25));
            if (filters.source && filters.source !== 'all') params.set('source', filters.source);
            if (filters.status && filters.status !== 'all') params.set('status', filters.status);
            if (filters.sortBy) {
                params.set('sortBy', filters.sortBy);
                params.set('sortDir', filters.sortDir ?? 'desc');
            }
            const json = await fetchJson<{ success: boolean; data: AgentOpsRun[]; total: number; stats: RunListStats }>(`/api/agent-ops?${params}`);
            return { runs: json.data ?? [], total: json.total ?? 0, stats: json.stats };
        },
        refetchInterval: (query) =>
            (query.state.data?.runs ?? []).some(r => ACTIVE.has(r.status)) ? 5000 : 30000,
    });
}
```

#### Page
- Add `pagination`/`setPagination` and `sorting`/`setSorting` state.
- Sorting change resets `pageIndex` to 0.
- Source/status filter change resets `pageIndex` to 0.
- Use `DataTable` with `manualPagination`, `manualSorting`, controlled state, `rowCount={total}`, custom card-list columns, and `DataTablePagination` footer.
- Stats cards read from `runsQuery.data?.stats`.

### 2. Scheduled Tasks pagination/sorting

Follow the same pattern as Agent Ops runs, but with a new query hook.

#### Types (in `scheduled-task/interface.ts`)
```ts
export interface TaskListQuery {
    tenantId: string;
    page?: number;
    limit?: number;
    sortBy?: 'name' | 'taskStatus' | 'nextRunAt' | 'lastRunAt' | 'createdAt' | 'updatedAt' | 'runCount';
    sortDir?: 'asc' | 'desc';
}

export interface TaskListStats {
    active: number;
    paused: number;
    totalRuns: number;
}
```

#### Repository
- Same offset/count pattern; default sort `createdAt desc`; filter out `deleted` tasks.
- Compute stats from the full un-paginated filtered result, or run a second aggregate query.

#### API route
- Parse pagination/sort params and return `{ success, data, total, stats }`.

#### Query hook (`apps/web-ui/lib/queries/agent-ops-scheduled-tasks.ts`)
- `useScheduledTasks(filters)` returns `{ tasks, total, stats }`.

#### Page
- Replace raw `fetch` + `useState` with the query hook.
- Add pagination/sort state and controls.
- Stats cards read from API `stats`.
- `onSaved` callback invalidates `queryKeys.agentOps.scheduledTasks.all` (add new key factory entries in `query-keys.ts`).

### 3. Query keys
Add to `queryKeys.agentOps`:
```ts
scheduledTasks: {
    all: ['scheduled-tasks'] as const,
    lists: () => [...queryKeys.agentOps.scheduledTasks.all, 'list'] as const,
    list: (filters?: unknown) => [...queryKeys.agentOps.scheduledTasks.lists(), filters ?? {}] as const,
},
```

### 4. Settings dropdown
In `apps/web-ui/app/app/agent-ops/page.tsx`, reduce the dropdown to:
```tsx
<DropdownMenuContent align="end">
    <DropdownMenuItem onClick={() => router.push("/app/agent-ops/settings")}>
        <Settings2 className="h-4 w-4 mr-2" /> Agent Defaults
    </DropdownMenuItem>
</DropdownMenuContent>
```
Remove unused imports (`MessageSquare`, `AlertCircle`, `Plug`) if they are no longer used elsewhere.

### 5. Default MCP servers
In `apps/web-ui/lib/agent/mcp-config.ts`:
```ts
export const DEFAULT_MCP_SERVERS: MCPServerConfig[] = [];
```
Remove the 14 entry array and the category comments. Keep the rest of the file (schema, validation, `defaultsToJson()`, `mergeConfigs()`) intact — they will naturally produce empty configs until the user adds servers.

## Testing plan
1. Run TypeScript checks: `cd apps/web-ui && bun run type-check` (or `bun run build:web` if type-check script is absent).
2. Run lint: `cd apps/web-ui && bun run lint`.
3. Run web-ui unit tests: `cd apps/web-ui && bun run test`.
4. Manual verification:
   - Open `/app/agent-ops`, change page size, click next page, verify URL/API params and row count.
   - Sort by Created/Updated/Status/Source and verify direction toggles.
   - Apply source/status filters and confirm page resets to 1.
   - Confirm stats cards show totals, not just current-page counts.
   - Open `/app/agent-ops/scheduled-tasks`, repeat pagination/sort checks.
   - Click **Settings** on Agent Ops page; verify only **Agent Defaults** appears.
   - Open `/app/settings/mcp-servers` or `/app/agent-ops/mcp-settings`; verify 0 default servers and the "Add MCP server" button works.

## Risks / considerations
- **Stats consistency**: Stats are computed from the DB at list time. For runs, the existing auto-refetch (5 s when active) will refresh stats too.
- **Sortable fields**: Only expose fields that exist as top-level Prisma columns. `taskDescription`, `status`, `source`, `createdAt`, `updatedAt`, `durationMs` are safe for runs. `nextRunAt`/`lastRunAt` are Date columns in Prisma for tasks.
- **DynamoDB repository**: The interface references a DynamoDB implementation, but the file does not exist in this branch. Only the PostgreSQL repository needs updating; if a DynamoDB repo is reintroduced, the interface contract change must be implemented there too.
- **MCP default removal**: Existing tenants who previously saved a config are unaffected (saved config wins). New tenants see an empty list.
