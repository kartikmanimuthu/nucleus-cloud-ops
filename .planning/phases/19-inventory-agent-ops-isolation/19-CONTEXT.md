# Phase 19: Inventory & Agent Ops Isolation - Context

**Gathered:** 2026-04-03
**Status:** Ready for planning

<domain>
## Phase Boundary

Fix tenant scoping gaps in Inventory Discovery and AI Ops (Agent Ops) modules. Every list, search, detail, create, update, delete, and bulk operation must be correctly scoped to the active tenant. Includes the discovery Lambda write path (tenantId derived from accountId) and all agent ops sub-routes (approve, cancel, resume, events, scheduled tasks).

**In scope:**
- Inventory: list, search, detail, export, sync, status routes (INVT-01–03)
- Agent Ops runs: list, create, detail, approve, cancel, resume, events (AIOP-01–03)
- Scheduled tasks: list, create, update, delete, pause, resume, trigger, runs (AIOP-04)
- Discovery Lambda write path: derive tenantId from accountId at write time

**Out of scope:**
- Knowledge Base, Channels (Phase 20)
- Audit log full sweep (Phase 21)
- Lambda scheduler tenant scoping (separate concern)
- Rewriting discovery Lambda from Python to TypeScript

</domain>

<decisions>
## Implementation Decisions

### Tenant Client Pattern (carried from Phase 18)
- **D-01:** Migrate all four repositories to `getTenantClient(tenantId)`:
  - `InventoryPostgresRepository` (currently uses `getPrismaClient()`)
  - `AgentOpsRunPostgresRepository` (currently uses `getPrismaClient()`)
  - `AgentOpsEventPostgresRepository` (currently uses `getPrismaClient()`)
  - `ScheduledTaskPostgresRepository` (currently uses `getPrismaClient()`)
- **D-02:** All queries use the scoped client — no manual `where: { tenantId }` needed after migration (the `$extends` middleware handles it).

### Inventory Write Scoping (Lambda path)
- **D-03:** The discovery Lambda writes inventory records with an `accountId` but no session `tenantId`. At write time, resolve `tenantId` by looking up the account record: `SELECT tenant_id FROM accounts WHERE account_id = $accountId`. This keeps the Lambda stateless — no per-tenant config needed.
- **D-04:** The lookup happens in `InventoryPostgresRepository.upsertResource()` (or equivalent write method). If no matching account is found, the write should be skipped or logged as an error — never written with a null `tenantId`.
- **D-05:** API read routes (list, search, detail, export, sync) use `getSessionTenantId()` as normal — no change to the read path pattern.

### Cross-Tenant Mutation Protection (carried from Phase 18)
- **D-06:** All agent ops run sub-routes (approve, cancel, resume, events GET) do a pre-flight `getAgentOpsRun` scoped to `tenantId` before acting. If not found → return HTTP 403 `{ success: false, error: 'Forbidden' }`.
- **D-07:** The pre-flight check is in the API route layer (not the repository), consistent with Phase 18.
- **D-08:** Scheduled task mutations (pause, resume, trigger, delete) get pre-flight ownership checks → 403. The runs sub-route (`/scheduled-tasks/[taskId]/runs`) scopes the query by `tenantId + taskId` without a separate 403 check (it's a read).

### Inventory Bulk Operations
- **D-09:** Export and sync routes pass `tenantId` from `getSessionTenantId()` to the repository — same pattern as list/search. No special handling needed.

### Audit Log Calls
- **D-10:** Any `AuditService.logUserAction` or `AuditService.logResourceAction` calls in files touched by Phase 19 must include `tenantId` (forward-pull of AUDT-02, consistent with Phase 18 approach).

### Claude's Discretion
- Exact method name for inventory write in the repository (upsertResource, createOrUpdate, etc.) — read the interface before implementing
- Whether the account lookup in D-03 uses `getPrismaClient()` (acceptable for a cross-entity lookup that isn't tenant-scoped by definition) or a separate service call
- Order of plans within the phase

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase Requirements
- `.planning/REQUIREMENTS.md` — INVT-01–03, AIOP-01–04 acceptance criteria

### Tenant Isolation Pattern (established in Phase 18)
- `web-ui/lib/db/pg-config.ts` — `getTenantClient(tenantId)` factory
- `web-ui/lib/db/repositories/account/postgres.ts` — migrated repo (reference implementation)
- `web-ui/lib/db/repositories/schedule/postgres.ts` — migrated repo (reference implementation)

### Repositories to Migrate
- `web-ui/lib/db/repositories/inventory/postgres.ts` — uses getPrismaClient, needs migration
- `web-ui/lib/db/repositories/inventory/interface.ts` — IInventoryRepository interface
- `web-ui/lib/db/repositories/agent-ops-run/postgres.ts` — uses getPrismaClient, needs migration
- `web-ui/lib/db/repositories/agent-ops-run/interface.ts`
- `web-ui/lib/db/repositories/agent-ops-event/postgres.ts` — uses getPrismaClient, needs migration
- `web-ui/lib/db/repositories/agent-ops-event/interface.ts`
- `web-ui/lib/db/repositories/scheduled-task/postgres.ts` — uses getPrismaClient, needs migration
- `web-ui/lib/db/repositories/scheduled-task/interface.ts`

### API Routes
- `web-ui/app/api/inventory/resources/route.ts`
- `web-ui/app/api/inventory/export/route.ts`
- `web-ui/app/api/inventory/sync/route.ts`
- `web-ui/app/api/inventory/status/route.ts`
- `web-ui/app/api/agent-ops/route.ts`
- `web-ui/app/api/agent-ops/[runId]/route.ts`
- `web-ui/app/api/agent-ops/[runId]/approve/route.ts`
- `web-ui/app/api/agent-ops/[runId]/cancel/route.ts`
- `web-ui/app/api/agent-ops/[runId]/resume/route.ts`
- `web-ui/app/api/agent-ops/scheduled-tasks/route.ts`
- `web-ui/app/api/agent-ops/scheduled-tasks/[taskId]/route.ts`
- `web-ui/app/api/agent-ops/scheduled-tasks/[taskId]/pause/route.ts`
- `web-ui/app/api/agent-ops/scheduled-tasks/[taskId]/resume/route.ts`
- `web-ui/app/api/agent-ops/scheduled-tasks/[taskId]/trigger/route.ts`
- `web-ui/app/api/agent-ops/scheduled-tasks/[taskId]/runs/route.ts`

### Auth / Session
- `web-ui/lib/auth-session.ts` — `getSessionTenantId()` helper

### Audit
- `web-ui/lib/audit-service.ts` — `AuditService.logUserAction()` / `logResourceAction()` signatures

</canonical_refs>
