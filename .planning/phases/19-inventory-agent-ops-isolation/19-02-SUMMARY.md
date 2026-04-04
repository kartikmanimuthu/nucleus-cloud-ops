---
phase: 19-inventory-agent-ops-isolation
plan: "02"
subsystem: agent-ops
tags: [tenant-isolation, agent-ops, scheduled-tasks, rbac, security]
dependency_graph:
  requires: [19-01]
  provides: [AIOP-01, AIOP-02, AIOP-03, AIOP-04]
  affects: [agent-ops-run-repo, agent-ops-event-repo, scheduled-task-repo, agent-ops-api-routes]
tech_stack:
  added: []
  patterns: [getTenantClient, getSessionTenantId, pre-flight-403]
key_files:
  created: []
  modified:
    - web-ui/lib/db/repositories/agent-ops-run/postgres.ts
    - web-ui/lib/db/repositories/agent-ops-event/postgres.ts
    - web-ui/lib/db/repositories/scheduled-task/postgres.ts
    - web-ui/lib/agent-ops/agent-ops-service.ts
    - web-ui/app/api/agent-ops/route.ts
    - web-ui/app/api/agent-ops/[runId]/route.ts
    - web-ui/app/api/agent-ops/[runId]/approve/route.ts
    - web-ui/app/api/agent-ops/[runId]/cancel/route.ts
    - web-ui/app/api/agent-ops/[runId]/resume/route.ts
    - web-ui/app/api/agent-ops/scheduled-tasks/route.ts
    - web-ui/app/api/agent-ops/scheduled-tasks/[taskId]/route.ts
    - web-ui/app/api/agent-ops/scheduled-tasks/[taskId]/pause/route.ts
    - web-ui/app/api/agent-ops/scheduled-tasks/[taskId]/resume/route.ts
    - web-ui/app/api/agent-ops/scheduled-tasks/[taskId]/trigger/route.ts
    - web-ui/app/api/agent-ops/scheduled-tasks/[taskId]/runs/route.ts
decisions:
  - "getTenantClient(tenantId) in all 3 agent-ops repositories for tenant-scoped operations"
  - "Cross-tenant webhook lookup methods (findAwaiting*, listRunsBySource) explicitly kept on getPrismaClient with comments"
  - "listAllActiveTasks and tryAcquireExecutionLock kept on getPrismaClient — scheduler engine and platform-level locks are cross-tenant by design"
  - "getRunEvents signature updated to accept tenantId — removes hardcoded 'default'"
  - "All 11 agent-ops API routes derive tenantId from getSessionTenantId() — no query param / body extraction"
  - "Pre-flight 403 on approve, cancel, resume (D-06) and pause, resume, trigger, PATCH, DELETE scheduled-task routes (D-08)"
metrics:
  duration: "~15 minutes"
  completed: "2026-04-03"
  tasks_completed: 2
  files_modified: 15
---

# Phase 19 Plan 02: Agent Ops & Scheduled Tasks Tenant Isolation Summary

Tenant isolation hardening for Agent Ops and Scheduled Tasks — 3 repositories migrated from getPrismaClient() to getTenantClient(tenantId), getRunEvents fixed to accept tenantId, and all 11 API routes now derive tenantId from the authenticated session with pre-flight 403 ownership checks on all mutation sub-routes.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Migrate 3 agent-ops repositories to getTenantClient | 8666345 | agent-ops-run/postgres.ts, agent-ops-event/postgres.ts, scheduled-task/postgres.ts, agent-ops-service.ts |
| 2 | Harden 11 agent-ops API routes with session tenantId and 403 pre-flight checks | 7624c67 | All 11 agent-ops route files |

## What Changed

### Task 1 — Repository Layer

**agent-ops-run/postgres.ts:**
- `createRun`, `updateRunStatus`, `updateRunTrigger`, `updateApprovalMessageTs`, `getRun`, `listRuns` → `getTenantClient(tenantId)`
- `listRuns` removes the `'default'`/`'all'` bypass — always requires tenantId, throws if missing
- `listRunsBySource`, `findAwaitingApprovalRun`, `findAwaitingApprovalRunByJiraIssue`, `findAwaitingRunByJiraIssue`, `findAwaitingRunBySlackThread` → kept on `getPrismaClient()` with explicit cross-tenant comments (webhook handlers operate without knowing tenantId)

**agent-ops-event/postgres.ts:**
- `getRunEvents(runId, tenantId)` → `getTenantClient(tenantId)` (already had correct signature)
- `recordEvent` kept on `getPrismaClient()` — never-throw path, tenantId not available at call site

**scheduled-task/postgres.ts:**
- `createScheduledTask`, `getScheduledTask`, `listScheduledTasks`, `updateScheduledTask`, `pauseScheduledTask`, `resumeScheduledTask`, `deleteScheduledTask`, `updateLastRun` → `getTenantClient(tenantId)`
- `listAllActiveTasks` kept on `getPrismaClient()` — scheduler engine scans all tenants
- `tryAcquireExecutionLock` kept on `getPrismaClient()` — platform-level lock table has no tenantId

**agent-ops-service.ts:**
- `getRunEvents(runId: string, tenantId: string)` — removes hardcoded `'default'`

### Task 2 — API Route Layer

All 11 routes now call `getSessionTenantId()` at the top of each handler. Removed all `|| 'default'` fallbacks and query-param/body tenantId extraction.

Pre-flight 403 ownership checks added per D-06 and D-08:
- `[runId]/approve` — `getRun(tenantId, runId)` → 403 if null
- `[runId]/cancel` — `getRun(tenantId, runId)` → 403 if null
- `[runId]/resume` — `getRun(tenantId, runId)` → 403 if null
- `scheduled-tasks/[taskId] PATCH` — `getScheduledTask(tenantId, taskId)` → 403 if null
- `scheduled-tasks/[taskId] DELETE` — `getScheduledTask(tenantId, taskId)` → 403 if null
- `scheduled-tasks/[taskId]/pause` — `getScheduledTask(tenantId, taskId)` → 403 if null
- `scheduled-tasks/[taskId]/resume` — `getScheduledTask(tenantId, taskId)` → 403 if null
- `scheduled-tasks/[taskId]/trigger` — `getScheduledTask(tenantId, taskId)` → 403 if null

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Self-Check: PASSED

Files exist:
- web-ui/lib/db/repositories/agent-ops-run/postgres.ts ✓
- web-ui/lib/db/repositories/agent-ops-event/postgres.ts ✓
- web-ui/lib/db/repositories/scheduled-task/postgres.ts ✓
- web-ui/lib/agent-ops/agent-ops-service.ts ✓
- All 11 agent-ops API route files ✓

Commits exist:
- 8666345 (Task 1) ✓
- 7624c67 (Task 2) ✓
