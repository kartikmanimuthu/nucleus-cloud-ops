---
phase: 21-audit-settings-regression-tests
plan: "01"
subsystem: audit-log
tags: [tenant-isolation, audit, postgresql, rbac]
dependency_graph:
  requires: []
  provides: [tenant-scoped-audit-reads, tenant-scoped-audit-writes]
  affects: [web-ui/lib/db/repositories/audit-log, web-ui/app/api/audit, web-ui/app/api/scheduler, web-ui/app/api/schedules, web-ui/app/api/inventory]
tech_stack:
  added: []
  patterns: [getTenantClient-per-query, getSessionTenantId-in-route]
key_files:
  created: []
  modified:
    - web-ui/lib/db/repositories/audit-log/postgres.ts
    - web-ui/app/api/audit/route.ts
    - web-ui/app/api/scheduler/execute/route.ts
    - web-ui/app/api/scheduler/settings/route.ts
    - web-ui/app/api/schedules/route.ts
    - web-ui/app/api/schedules/[scheduleId]/execute/route.ts
decisions:
  - "AuditLogPostgresRepository uses getTenantClient(tenantId) for both createAuditLog and getAuditLogs — consistent with Phase 18/19/20 pattern"
  - "tenantId promoted from metadata-only to top-level property in all logUserAction/logResourceAction calls so repository layer can extract it"
  - "inventory/sync and tenants/settings/logo routes confirmed already correctly scoped — no changes needed"
metrics:
  duration: "~10 minutes"
  completed: "2026-04-03"
  tasks_completed: 2
  files_modified: 6
requirements: [AUDT-01, AUDT-02, STNG-04, STNG-05]
---

# Phase 21 Plan 01: Audit Log Tenant Isolation + Settings Verification Summary

Migrated AuditLogPostgresRepository from getPrismaClient() to getTenantClient(tenantId) for both reads and writes; fixed /api/audit GET/POST to extract tenantId from session; swept all AuditService call sites to include tenantId as a top-level property; confirmed settings and logo routes already correctly scoped.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Migrate AuditLogPostgresRepository to getTenantClient + fix audit route | 54ebf08 | postgres.ts, audit/route.ts |
| 2 | Sweep all AuditService call sites + verify settings/logo routes | 62c7171 | scheduler/execute, scheduler/settings, schedules/route, schedules/[id]/execute |

## Decisions Made

- `getTenantClient(tenantId)` replaces `getPrismaClient()` in both `createAuditLog` and `getAuditLogs` — consistent with the pattern established in Phases 18–20
- `tenantId` promoted from `metadata: { tenantId }` to a top-level property in all `logUserAction`/`logResourceAction` calls so the repository layer can extract it from `auditData`
- `inventory/sync`, `tenants/settings`, and `tenants/logo` routes confirmed already correctly scoped — zero changes needed

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Removed duplicate `const tenantId` declaration in schedules/[scheduleId]/execute/route.ts**
- Found during: Task 2
- Issue: `const tenantId = await getSessionTenantId()` declared twice (lines 28 and 38) — TypeScript would error on duplicate const in same scope
- Fix: Removed the second declaration; first declaration at line 28 is sufficient
- Files modified: `web-ui/app/api/schedules/[scheduleId]/execute/route.ts`
- Commit: 62c7171

## Verification Results

1. `getPrismaClient` in audit repo: 0 occurrences (removed)
2. `getTenantClient` in audit repo: 3 occurrences (import + createAuditLog + getAuditLogs)
3. `getSessionTenantId` in audit route: 2 call sites (GET + POST)
4. `getSessionTenantId` in tenants/settings: 2 call sites (GET + PUT) — pre-existing, confirmed
5. `getSessionTenantId` in tenants/logo: 2 call sites (POST + PUT) — pre-existing, confirmed
6. All modified audit call sites include `tenantId` as top-level property

## Known Stubs

None.

## Self-Check: PASSED
