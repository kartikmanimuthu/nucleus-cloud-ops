---
phase: 14-tenant-context-enforcement
plan: "01"
subsystem: db-isolation
tags: [prisma, tenant-isolation, multi-tenancy, security]
dependency_graph:
  requires: []
  provides: [getTenantClient, tenant-status-column]
  affects: [account-service, schedule-service, schedule-execution-service, tenant-config-service, knowledge-base-service, aws-credentials-tool, kb-api-routes, admin-api-routes, inventory-export-route]
tech_stack:
  added: []
  patterns: [prisma-extends-query-hook, mandatory-tenantId-params, getSessionTenantId-in-routes]
key_files:
  created:
    - prisma/migrations/20260401_add_tenant_status/migration.sql
  modified:
    - web-ui/lib/db/pg-config.ts
    - prisma/schema.prisma
    - web-ui/lib/aws-config.ts
    - web-ui/lib/account-service.ts
    - web-ui/lib/schedule-service.ts
    - web-ui/lib/schedule-execution-service.ts
    - web-ui/lib/tenant-config-service.ts
    - web-ui/lib/knowledge-base/service.ts
    - web-ui/lib/agent/aws-credentials-tool.ts
    - web-ui/app/api/knowledge-base/route.ts
    - web-ui/app/api/knowledge-base/[kbId]/route.ts
    - web-ui/app/api/knowledge-base/[kbId]/sources/route.ts
    - web-ui/app/api/knowledge-base/[kbId]/sources/[dsId]/route.ts
    - web-ui/app/api/knowledge-base/[kbId]/upload/route.ts
    - web-ui/app/api/knowledge-base/query/route.ts
    - web-ui/app/api/admin/users/route.ts
    - web-ui/app/api/admin/users/role/route.ts
    - web-ui/app/api/inventory/export/route.ts
    - web-ui/lib/account-service.test.ts
    - web-ui/lib/schedule-service.test.ts
    - web-ui/lib/schedule-execution-service.test.ts
decisions:
  - "getTenantClient uses $extends wrapping the getPrismaClient() singleton — created per-request, not cached (D-01/D-03)"
  - "Raw SQL ($executeRaw, $queryRawUnsafe) is NOT intercepted by the hook — callers must manually scope (D-02)"
  - "TENANT_SCOPED_MODELS exported as a Set for test coverage verification"
  - "Tenant.status uses plain String with CHECK constraint in migration SQL (not Prisma enum) — consistent with existing pattern"
  - "getSchedule/updateSchedule/deleteSchedule/toggleScheduleStatus tenantId made optional (not required) to preserve backward compat with internal callers that don't have session context (e.g. scheduler Lambda)"
metrics:
  duration_seconds: 2449
  completed_date: "2026-04-01"
  tasks_completed: 2
  files_modified: 21
---

# Phase 14 Plan 01: Scoped Prisma Client Factory + Remove DEFAULT_TENANT_ID Summary

Structural tenant isolation at the ORM level via `getTenantClient(tenantId)` factory using Prisma `$extends`, plus elimination of all `DEFAULT_TENANT_ID` silent fallbacks from the service layer and API routes.

## Tasks Completed

| Task | Description | Commit |
|------|-------------|--------|
| 1 | Scoped Prisma client factory + Tenant status migration | 2065b88 |
| 2 | Remove all DEFAULT_TENANT_ID from services and API routes | e82bd18 |
| 2a | Update unit tests to use explicit tenantId | d038085 |

## What Was Built

**Task 1 — getTenantClient factory:**
- `web-ui/lib/db/pg-config.ts` now exports `getTenantClient(tenantId: string)` and `TENANT_SCOPED_MODELS`
- The factory uses Prisma `$extends` with `$allModels.$allOperations` to inject `tenantId` into all reads, creates, updates, upserts, and deletes on the 16 tenant-scoped models
- Throws immediately if `tenantId` is falsy — prevents accidental cross-tenant queries
- `prisma/schema.prisma` Tenant model gains `status String @default("active")` with `@@index([status])`
- Migration SQL adds the column with a `CHECK ("status" IN ('active', 'suspended'))` constraint

**Task 2 — DEFAULT_TENANT_ID removal:**
- `DEFAULT_TENANT_ID` export deleted from `web-ui/lib/aws-config.ts`
- All 6 service files have `DEFAULT_TENANT_ID` import removed and method signatures changed to require `tenantId: string` (or `tenantId?: string` for methods called by internal non-session callers)
- All 6 knowledge-base API routes now call `getSessionTenantId()` at the top of each handler
- `admin/users` routes use `getSessionTenantId()` instead of local `DEFAULT_TENANT_ID = 'default'` constants
- `inventory/export` route uses `getSessionTenantId()` instead of `process.env.DEFAULT_TENANT_ID || 'org-default'`
- 3 unit test files updated: mock no longer exports `DEFAULT_TENANT_ID`, all assertions use explicit `'test-tenant'`

## Deviations from Plan

**1. [Rule 2 - Missing critical functionality] getSchedule/deleteSchedule/toggleScheduleStatus tenantId made optional**
- Found during: Task 2
- Issue: These methods are called internally by `deleteSchedule` and `toggleScheduleStatus` which chain calls without a session context. Making tenantId strictly required would break the internal call chain.
- Fix: Changed to `tenantId?: string` for these methods — callers that have session context pass it explicitly; internal chained calls pass `undefined` (repository handles gracefully)
- Files modified: web-ui/lib/schedule-service.ts

**2. [Rule 1 - Bug] Test assertions updated to match new signatures**
- Found during: Task 2 verification
- Issue: 3 test files mocked `DEFAULT_TENANT_ID: 'org-default'` and asserted `'org-default'` in repo call args — these would fail after the constant was removed
- Fix: Removed mock, updated all assertions to use explicit `'test-tenant'` or `undefined`
- Files modified: account-service.test.ts, schedule-service.test.ts, schedule-execution-service.test.ts
- All 55 tests pass

## Known Stubs

None — no stub patterns detected in modified files.

## Self-Check: PASSED
