# Phase 20: Knowledge Base & Channels Isolation - Context

**Gathered:** 2026-04-03
**Status:** Ready for planning

<domain>
## Phase Boundary

Fix tenant scoping gaps in Knowledge Base CRUD (including data sources, upload, sync, and query) and Channels (Slack/Jira settings via TenantConfigService). Every list, create, update, delete, upload, sync, and query operation must be correctly scoped to the active tenant.

**In scope:**
- Knowledge Base: list, create, update, delete, query (KB-01–05)
- Data Sources: list, create, update, delete, sync (KB-05)
- Channels: Slack settings GET/PUT, Jira settings GET/PUT (CHAN-01–04)

**Out of scope:**
- Audit log full sweep (Phase 21)
- v1/trigger/slack and v1/trigger/jira webhook routes (external webhooks, not user-facing CRUD)

</domain>

<decisions>
## Implementation Decisions

### Tenant Client Pattern (carried from Phases 18/19)
- **D-01:** Migrate `KnowledgeBasePostgresRepository` from `getPrismaClient()` to `getTenantClient(tenantId)`
- **D-02:** Migrate `DataSourcePostgresRepository` from `getPrismaClient()` to `getTenantClient(tenantId)`
- **D-03:** All new queries use the scoped client — no manual `where: { tenantId }` needed after migration

### Cross-Tenant Mutation Protection (carried from Phases 18/19)
- **D-04:** Pre-flight ownership check on `[kbId]` PUT/DELETE: `getKnowledgeBase(kbId, tenantId)` → 403 if not found
- **D-05:** Pre-flight ownership check on all data source mutations (`[dsId]` PUT/DELETE/sync): verify parent KB belongs to tenant first → 403 if not
- **D-06:** 403 response body: `{ success: false, error: 'Forbidden' }` (consistent with Phases 18/19)
- **D-07:** Pre-flight checks in API route layer (not repository)

### KB Upload and Sync Routes
- **D-08:** `/[kbId]/upload` and `/[kbId]/sources/[dsId]/sync` routes: add pre-flight ownership check on `kbId` → 403 if not tenant's. Pass `tenantId` from `getSessionTenantId()` to the operation.

### KB Query Route
- **D-09:** `/knowledge-base/query` route: pass `tenantId` from `getSessionTenantId()` to scope the RAG query to only the active tenant's knowledge bases. Prevents cross-tenant vector search leakage.

### Channels (TenantConfigService)
- **D-10:** `/api/agent-ops/settings/slack` GET and PUT: add `const tenantId = await getSessionTenantId()` and pass it to all `TenantConfigService.getConfig(key, tenantId)` and `TenantConfigService.saveConfig(key, data, tenantId, updatedBy)` calls.
- **D-11:** `/api/agent-ops/settings/jira` GET and PUT: same fix as D-10.
- **D-12:** `TenantConfigService` already accepts `tenantId` — no changes needed to the service itself, only the routes.

### Audit Log Calls
- **D-13:** Any `AuditService.log*` calls in files touched by Phase 20 must include `tenantId` (forward-pull of AUDT-02, consistent with Phases 18/19).

### Claude's Discretion
- Exact method names in KB/DataSource repositories (read interface files before implementing)
- Whether KB query uses a separate `tenantId` filter or relies on the scoped client
- Order of plans within the phase

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase Requirements
- `.planning/REQUIREMENTS.md` — KB-01–05, CHAN-01–04 acceptance criteria

### Tenant Isolation Pattern (established in Phases 18/19)
- `web-ui/lib/db/pg-config.ts` — `getTenantClient(tenantId)` factory
- `web-ui/lib/db/repositories/account/postgres.ts` — migrated repo (reference)
- `web-ui/lib/db/repositories/schedule/postgres.ts` — migrated repo (reference)

### Repositories to Migrate
- `web-ui/lib/db/repositories/knowledge-base/postgres.ts` — uses getPrismaClient
- `web-ui/lib/db/repositories/knowledge-base/interface.ts`
- `web-ui/lib/db/repositories/data-source/postgres.ts` — uses getPrismaClient
- `web-ui/lib/db/repositories/data-source/interface.ts`

### API Routes
- `web-ui/app/api/knowledge-base/route.ts`
- `web-ui/app/api/knowledge-base/[kbId]/route.ts`
- `web-ui/app/api/knowledge-base/[kbId]/sources/route.ts`
- `web-ui/app/api/knowledge-base/[kbId]/sources/[dsId]/route.ts`
- `web-ui/app/api/knowledge-base/[kbId]/sources/[dsId]/sync/route.ts`
- `web-ui/app/api/knowledge-base/[kbId]/upload/route.ts`
- `web-ui/app/api/knowledge-base/query/route.ts`
- `web-ui/app/api/agent-ops/settings/slack/route.ts`
- `web-ui/app/api/agent-ops/settings/jira/route.ts`

### Channels Service
- `web-ui/lib/tenant-config-service.ts` — TenantConfigService (already accepts tenantId)

### Auth / Session
- `web-ui/lib/auth-session.ts` — `getSessionTenantId()` helper

### Audit
- `web-ui/lib/audit-service.ts` — `AuditService.logUserAction()` signature

</canonical_refs>
