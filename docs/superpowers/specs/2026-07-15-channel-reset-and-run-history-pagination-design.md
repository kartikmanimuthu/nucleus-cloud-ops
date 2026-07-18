# Channel Reset + Scheduled-Task Run History Pagination — Design

Date: 2026-07-15
Status: Approved

Two independent, small changes to the Agentic Ops UI.

---

## 1. Channel reset

### Problem

The Channels overview offers a `Reconfigure` action on every configured card, which
duplicates `Configure` and implies a distinct flow that does not exist. There is no way
to *clear* a channel's stored credentials from the UI at all — the only path back to an
unconfigured state is a manual DB edit.

### Design

**Channels overview** (`app/app/channels/page.tsx`): the primary card button always
reads `Configure`, regardless of state. `Deactivate`/`Activate` is unchanged.

**API**: add a `DELETE` handler to each channel settings route
(`/api/agent-ops/settings/{slack,jira,discord,telegram,webhook}`). Each handler:

- `authorize('delete', 'Agent')` — gated properly. (The existing `PUT` handlers only
  authorize on the secret-*reveal* path, not the write itself; `DELETE` does not copy
  that gap.)
- `TenantConfigService.deleteConfig(CONFIG_KEY, tenantId)`.
- Audit-logs `agent.settings.<channel>_reset`, severity `high` — it destroys credentials.
- **Slack only:** additionally deletes the tenant's `slack_workspace_links` row. Leaving
  it would keep a `team_id → tenant` mapping pointing at a tenant with no signing secret,
  which is exactly the broken state that made inbound slash commands fail with
  `[SlackAdapter] Signing secret not configured`. Requires a new repository method,
  `deleteLinkForTenant(tenantId)`.

Channel status on the cards derives from each route's `configured` flag (i.e. "does the
config row exist"), so deleting the config flips the card back to `Not configured` with
no extra plumbing.

**UI**: a shared `ChannelResetCard` (`components/channels/channel-reset-card.tsx`) placed
at the bottom of all five settings forms. Props: `{ channel, name, clears }`. Renders a
quiet danger-styled card — "Reset configuration", one line of description, a `Reset`
button — wired to the existing `AlertDialog` primitive for a confirm step. It renders
only when the channel is configured, so a fresh setup page stays clean.

**Data layer**: `useResetChannelSettings(channel)` in `lib/queries/channel-settings.ts`,
alongside the existing save/toggle hooks. On success it invalidates `['channels','status']`
and the per-channel settings key, then fires a `sonner` toast.

### Scope choices

- Reset does not touch the `enabled` flag separately — the whole config row goes.
- No reset on the MCP or Providers pages; both already have per-item delete.

### Testing

Unit tests for the five `DELETE` routes (config deleted, 403 without permission) and for
Slack reset removing the workspace link.

---

## 2. Scheduled-task run history pagination

### Problem

`GET /api/agent-ops/scheduled-tasks/[taskId]/runs` fetches the last N scheduled runs for
the **whole tenant** (`listRuns({ source: 'scheduled', limit })`) and then filters by
`taskId` in JavaScript. The run history is therefore silently lossy: once other tasks'
runs fill the window, this task's older runs disappear from the page. Pagination cannot
be built on top of that, and the displayed count cannot be trusted.

### Design

**Repository / types**: add `taskId?: string` to `RunListQuery`. In
`AgentOpsRunPostgresRepository.listRuns`, apply it to the where-clause as a JSON-path
filter — `trigger: { path: ['taskId'], equals: taskId }` — the same pattern
`listActiveRunsByTask` already uses against this schema. `listRuns` already does
`skip`/`take`/`count` and returns `{ runs, total }`, so pagination follows for free.

**Route**: read `page` and `limit` from the query string, pass
`{ tenantId, source: 'scheduled', taskId, page, limit }` through, return `{ runs, total }`.
The in-JS `.filter()` is removed.

**Client**: `useScheduledTaskRuns(taskId, { page, limit })` in `lib/queries/`, keyed via
the central `query-keys.ts` factory, mirroring `useScheduledTasks`. The detail page holds
`page`/`pageSize` state and renders the shared `<PaginationBar>` primitive with
`itemLabel="runs"` — the same bar the tasks list uses.

Only the Run History section moves to TanStack Query; the rest of the detail page's raw
`fetch` calls are left alone to keep the diff contained (the page predates the query-hook
convention — worth a separate follow-up).

### Known limitation (accepted)

The JSON-path filter on `trigger->>'taskId'` is unindexed; `AgentOpsRun` indexes
`tenantId` and `[tenantId, source]` among others. Combined with `tenantId` +
`source = 'scheduled'` the scan is narrow enough at current run volumes. If scheduled-run
volume grows, the fix is a GIN index on `trigger` or a promoted `taskId` column. Not done
now (YAGNI).

### Testing

- Repository: `listRuns({ taskId })` returns only that task's runs, with a correct `total`
  — the regression the current in-JS filter cannot pass.
- Route: `page`/`limit` passthrough.
