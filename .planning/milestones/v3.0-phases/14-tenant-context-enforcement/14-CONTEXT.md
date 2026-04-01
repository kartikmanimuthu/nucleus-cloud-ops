# Phase 14: Tenant Context Enforcement - Context

**Gathered:** 2026-04-01 (assumptions mode)
**Status:** Ready for planning

<domain>
## Phase Boundary

Every database query is scoped to the requesting tenant; cross-tenant data access is structurally impossible. Scoped Prisma client factory enforces tenant_id on every query. All DEFAULT_TENANT_ID fallbacks removed — missing tenant_id is a hard error. Scheduler Lambda filters by tenant and skips suspended tenants. Discovery Lambda includes tenant_id in all writes. LangGraph thread IDs namespaced with tenantId; thread access validated against session. Two-tenant isolation test proves cross-tenant access is impossible.

</domain>

<decisions>
## Implementation Decisions

### Scoped Prisma Client
- **D-01:** `getTenantClient(tenantId)` factory uses Prisma Client Extensions (`$extends`) wrapping the existing singleton from `getPrismaClient()` in `pg-config.ts`. Injects `WHERE tenant_id = $1` on every `findMany`, `findFirst`, `create`, `update`, `delete`, and `count` operation automatically.
- **D-02:** Raw SQL queries (`$executeRaw`, `$queryRawUnsafe`) are NOT intercepted by Extensions — every raw query in the codebase (persistence.ts vector upsert, inventory/postgres.ts vector search) must be manually scoped with explicit `tenant_id` parameter.
- **D-03:** Scoped client is created per-request (lightweight — Extensions wrap, don't clone the connection pool). No caching of extended clients.

### DEFAULT_TENANT_ID Removal
- **D-04:** All service method signatures change from `tenantId: string = DEFAULT_TENANT_ID` to `tenantId: string` (required, no default). Affected: ~8 service files, ~12 API routes, 2 Lambda functions.
- **D-05:** API routes source tenantId from `getSessionTenantId()` (which already throws on missing tenantId). Lambda functions source tenantId from the schedule/resource record itself.
- **D-06:** The `DEFAULT_TENANT_ID` constant and all imports of it are deleted from the codebase entirely. No env var, no fallback.

### Scheduler Lambda Tenant Isolation
- **D-07:** Scheduler Lambda iterates all active tenants by querying the `Tenant` table for `status = 'active'`, then fetches and processes schedules per tenant.
- **D-08:** Add a minimal `status` enum column (`active` | `suspended`) to the Tenant Prisma model in this phase. Phase 15 adds the full suspension enforcement (read-only vs locked modes), but Phase 14 needs the column for the scheduler to filter on.
- **D-09:** Scheduler processes tenants sequentially (not parallel) — Lambda timeout is sufficient for current scale. Parallel processing is a future optimization if tenant count grows significantly.

### Discovery Lambda Tenant Isolation
- **D-10:** Discovery Lambda includes `tenant_id` in all DynamoDB inventory writes and as an SQS message attribute on messages sent to the vector processor queue.
- **D-11:** Discovery Lambda sources `tenant_id` from the AWS account record it's scanning (each account belongs to a tenant). The account→tenant mapping is read at scan start.

### LangGraph Thread Isolation
- **D-12:** Thread IDs restructured to namespaced format `tenantId:userId:uuid`. New threads use this format; existing threads need a one-time migration script.
- **D-13:** Thread load in chat route and thread list API validates that the embedded `tenantId` matches the session's tenantId. Mismatch returns 403.
- **D-14:** Tenant-scoped wrapper around `PostgresSaver` and `getChatHistory()` — always validates/prepends tenantId before any checkpoint or history operation. This is preferred over embedding tenantId in the thread ID string alone (defense in depth).
- **D-15:** Fix `PostgresChatHistory` in persistence.ts which currently conflates `userId` with `tenantId` — correct to use actual tenantId from session.

### Two-Tenant Isolation Test
- **D-16:** Integration test creates two tenants (A and B), seeds data for both, then verifies: (a) Tenant A's scoped client cannot read Tenant B's data, (b) Tenant B's scoped client cannot read Tenant A's data, (c) create/update/delete operations are scoped correctly. Covers all modules: accounts, schedules, inventory, audit, agent threads.

### Claude's Discretion
- Exact Prisma Client Extension implementation details (query vs allOperations hook)
- Migration script approach for existing thread IDs (batch vs lazy migration)
- Test fixture setup for two-tenant isolation test
- Error message wording for tenant mismatch 403 responses
- Whether to add tenant_id index on any tables that don't have it yet

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Prisma schema and client
- `web-ui/prisma/schema.prisma` — All models with tenantId columns, Tenant model definition
- `web-ui/lib/db/pg-config.ts` — Current PrismaClient singleton (getTenantClient wraps this)

### Service layer (DEFAULT_TENANT_ID removal targets)
- `web-ui/lib/account-service.ts` — 8 methods with DEFAULT_TENANT_ID default
- `web-ui/lib/schedule-service.ts` — 6 methods with DEFAULT_TENANT_ID default
- `web-ui/lib/schedule-execution-service.ts` — 3 methods with DEFAULT_TENANT_ID default
- `web-ui/lib/tenant-config-service.ts` — 4 methods with DEFAULT_TENANT_ID default
- `web-ui/lib/knowledge-base/service.ts` — 7 methods with DEFAULT_TENANT_ID default
- `web-ui/lib/agent/aws-credentials-tool.ts` — DEFAULT_TENANT_ID usage in agent tools

### Auth session (tenantId source)
- `web-ui/lib/auth-session.ts` — getSessionTenantId() helper (throws on missing)
- `web-ui/middleware.ts` — x-tenant-id header injection

### Lambda functions
- `lambda/scheduler/src/services/scheduler-service.ts` — Hardcoded DEFAULT_TENANT_ID on lines 24, 36
- `lambda/scheduler/src/services/pg-service.ts` — Already accepts tenantId param, scopes queries
- `lambda/discovery/src/data_processor.py` — DynamoDB inventory writes + S3 normalized output

### LangGraph persistence
- `web-ui/lib/agent/persistence.ts` — PostgresSaver, PostgresChatHistory, raw SQL queries
- `web-ui/app/api/chat/route.ts` — Thread ID assignment (line 49, no tenant validation)
- `web-ui/app/api/threads/route.ts` — Thread list (full scan, no tenant filter)

### Repository layer (raw SQL to manually scope)
- `web-ui/lib/db/repositories/inventory/postgres.ts` — Vector search raw SQL (line ~284)

### Requirements
- `.planning/REQUIREMENTS.md` — ISOL-01 through ISOL-06

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `web-ui/lib/db/pg-config.ts`: PrismaClient singleton — getTenantClient wraps this with Extensions
- `web-ui/lib/auth-session.ts`: `getSessionTenantId()` already throws on missing tenantId — natural replacement for DEFAULT_TENANT_ID
- `web-ui/middleware.ts`: Already injects `x-tenant-id` header from session (Phase 12)
- `lambda/scheduler/src/services/pg-service.ts`: Already accepts tenantId param and scopes queries — just needs caller to pass real tenantId instead of DEFAULT_TENANT_ID
- All Prisma models already have `tenantId` column with `@@index([tenantId])` from v1.0 migration

### Established Patterns
- Repository pattern: all DB access through `web-ui/lib/db/repositories/` — scoped client injected here
- Service layer static classes: `AccountService.getAccounts(tenantId)` — signature change is mechanical
- API route pattern: `authorize()` then `getSessionTenantId()` then service call — tenantId flows naturally
- `authorize()` from Phase 13 already reads role from session — same session provides tenantId

### Integration Points
- `web-ui/lib/db/pg-config.ts`: Add `getTenantClient(tenantId)` factory alongside existing `getPrismaClient()`
- Every service file: Remove DEFAULT_TENANT_ID default from method signatures
- Every API route: Replace `DEFAULT_TENANT_ID` with `getSessionTenantId()` call
- `lambda/scheduler/src/services/scheduler-service.ts`: Replace hardcoded DEFAULT_TENANT_ID with tenant iteration loop
- `web-ui/lib/agent/persistence.ts`: Add tenant-scoped wrappers, fix userId/tenantId conflation
- `web-ui/app/api/chat/route.ts`: Add tenantId validation on thread access
- `web-ui/app/api/threads/route.ts`: Add tenant filter to thread list query
- `web-ui/prisma/schema.prisma`: Add `status` enum to Tenant model

</code_context>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches for implementation details not covered by decisions above.

</specifics>

<deferred>
## Deferred Ideas

- Full suspension enforcement (read-only vs locked modes, session invalidation) — Phase 15
- Parallel tenant processing in scheduler Lambda — future optimization
- PostgreSQL Row-Level Security (RLS) as additional defense layer — future hardening
- Thread ID migration for existing data — can be lazy (migrate on access) or batch script

</deferred>

---

*Phase: 14-tenant-context-enforcement*
*Context gathered: 2026-04-01*
