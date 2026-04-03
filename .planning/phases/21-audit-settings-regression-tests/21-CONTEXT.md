# Phase 21: Audit, Settings & Regression Tests - Context

**Gathered:** 2026-04-03
**Status:** Ready for planning

<domain>
## Phase Boundary

Fix audit log scoping (read + write), verify settings isolation, and add regression tests to lock in tenant isolation guarantees across all modules.

**In scope:**
- Audit log: migrate AuditLogPostgresRepository to getTenantClient, fix audit route to scope by tenantId, full sweep of all AuditService call sites missing tenantId (AUDT-01, AUDT-02)
- Settings: verify /api/tenants/settings and /api/tenants/logo are correctly scoped (STNG-04, STNG-05)
- Regression tests: Vitest unit tests for all 10 migrated Postgres repositories (TEST-01), API route integration tests for cross-tenant isolation (TEST-02)

**Out of scope:**
- Super Admin Panel (ADMIN-01–07, deferred to v4.1+)
- Tenant Suspension (SUSP-01–04, deferred to v4.1+)
- E2E Playwright cross-tenant tests (unit-level sufficient for v4.0)

</domain>

<decisions>
## Implementation Decisions

### Audit Log Repository
- **D-01:** Migrate `AuditLogPostgresRepository` from `getPrismaClient()` to `getTenantClient(tenantId)` — same pattern as all prior phases.
- **D-02:** The audit log GET route (`/api/audit/route.ts`) must call `getSessionTenantId()` and pass `tenantId` to `AuditService.getLogs(filters, tenantId)`. Currently reads all logs unscoped.

### Audit Write Sweep (AUDT-02)
- **D-03:** Full sweep across all modules — find every `AuditService.logUserAction(...)` and `AuditService.logResourceAction(...)` call site that is missing `tenantId` and add it. This is a codebase-wide fix, not limited to files touched in prior phases.
- **D-04:** `tenantId` should be sourced from `getSessionTenantId()` at the route level and passed into the audit call. For Lambda/system-level audit calls (no session), derive `tenantId` from the resource being acted on (e.g., the schedule's tenantId).
- **D-05:** The 11 call sites currently missing `tenantId` (identified by grep) must all be fixed. The executor should re-run the grep after fixing to confirm 0 remaining.

### Settings Isolation
- **D-06:** `/api/tenants/settings` GET and PUT already use `getSessionTenantId()` and pass `tenantId` to `TenantSettingsService` — verify this is correct and no cross-tenant access is possible. No code changes expected, but the executor must confirm by reading the files.
- **D-07:** `/api/tenants/logo` POST and PUT — same verification. If `tenantId` is missing from any call, add it.

### Regression Tests — TEST-01 (Repository WHERE clause tests)
- **D-08:** Write Vitest unit tests for all 10 migrated Postgres repositories:
  1. `AccountPostgresRepository`
  2. `SchedulePostgresRepository`
  3. `ScheduleExecutionPostgresRepository`
  4. `InventoryPostgresRepository`
  5. `AgentOpsRunPostgresRepository`
  6. `AgentOpsEventPostgresRepository`
  7. `ScheduledTaskPostgresRepository`
  8. `AuditLogPostgresRepository`
  9. `KnowledgeBasePostgresRepository`
  10. `DataSourcePostgresRepository`
- **D-09:** Each test file should mock `getTenantClient` and verify it is called with the correct `tenantId` argument on every method. Tests should NOT require a real database — mock the Prisma client.
- **D-10:** Test files go in the existing `*.test.ts` pattern alongside the source files (e.g., `postgres.test.ts` already exists for most repos — add tenant isolation assertions to existing test files rather than creating new ones).

### Regression Tests — TEST-02 (Cross-tenant API isolation tests)
- **D-11:** Write API route integration tests that mock `getSessionTenantId()` to return `'tenant-a'` and verify that data belonging to `'tenant-b'` is not returned.
- **D-12:** Test the highest-risk routes: accounts list, schedules list, inventory list, agent ops runs list, knowledge base list, audit log list. Each test: mock session → call route → assert response contains only tenant-a data.
- **D-13:** Use Vitest with `vi.mock('@/lib/auth-session', ...)` to mock `getSessionTenantId`. Mock the repository factory to return a mock repo that tracks which `tenantId` was used.
- **D-14:** Test files go in `web-ui/tests/tenant-isolation/` (new directory). One file per module: `accounts.test.ts`, `schedules.test.ts`, etc.

### Claude's Discretion
- Exact structure of mock setup for getTenantClient in TEST-01
- Whether to add to existing postgres.test.ts files or create new tenant-isolation-specific test files
- Order of plans within the phase

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase Requirements
- `.planning/REQUIREMENTS.md` — AUDT-01, AUDT-02, STNG-04, STNG-05, TEST-01, TEST-02

### Audit Repository
- `web-ui/lib/db/repositories/audit-log/postgres.ts` — uses getPrismaClient, needs migration
- `web-ui/lib/db/repositories/audit-log/interface.ts`
- `web-ui/lib/audit-service.ts` — AuditService with logUserAction/logResourceAction signatures
- `web-ui/app/api/audit/route.ts` — missing tenantId scoping

### Settings Routes (verify only)
- `web-ui/app/api/tenants/settings/route.ts`
- `web-ui/app/api/tenants/logo/route.ts`

### Tenant Isolation Pattern (reference)
- `web-ui/lib/db/pg-config.ts` — getTenantClient factory
- `web-ui/lib/db/repositories/account/postgres.ts` — migrated repo (reference)

### Existing Test Files (add assertions to these)
- `web-ui/lib/db/repositories/account/postgres.test.ts`
- `web-ui/lib/db/repositories/schedule/postgres.test.ts`
- `web-ui/lib/db/repositories/inventory/postgres.test.ts`
- `web-ui/lib/db/repositories/agent-ops-run/postgres.test.ts`
- `web-ui/lib/db/repositories/agent-ops-event/postgres.test.ts`
- `web-ui/lib/db/repositories/scheduled-task/postgres.test.ts`
- `web-ui/lib/db/repositories/knowledge-base/postgres.test.ts`
- `web-ui/lib/db/repositories/data-source/postgres.test.ts`

### Auth / Session
- `web-ui/lib/auth-session.ts` — getSessionTenantId() helper

</canonical_refs>
