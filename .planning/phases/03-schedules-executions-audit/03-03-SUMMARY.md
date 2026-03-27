---
phase: 03-schedules-executions-audit
plan: 03
subsystem: service-wiring
tags: [service-delegation, repository-factory, dual-write, lambda, pg, vitest, multi-tenant]
dependency_graph:
  requires: [03-02]
  provides: [getScheduleRepository, getScheduleExecutionRepository, getAuditLogRepository, pg-service]
  affects: [03-04, 03-05]
tech_stack:
  added:
    - "pg@8.20.0 (lambda/scheduler) — raw PostgreSQL client for Lambda, avoids Prisma bundle"
    - "@types/pg (lambda/scheduler devDependency)"
  patterns:
    - "Repository factory functions for getScheduleRepository, getScheduleExecutionRepository, getAuditLogRepository"
    - "Service delegation — services call repository interfaces, not DynamoDB directly"
    - "Dual-write via DUAL_WRITE_SCHEDULES env flag — PG is source of truth, DynamoDB write is best-effort"
    - "USE_PG_SCHEDULES/USE_PG_AUDIT_LOGS feature flags for zero-downtime cutover"
    - "Lambda pg Pool with max:3, idleTimeoutMillis:10000 (SCHED-06 constraint)"
    - "WHERE tenant_id = $1 on every pg-service query (multi-tenant safety)"
    - "Vitest unit tests with vi.mock patterns matching account repository tests"
key_files:
  created:
    - lambda/scheduler/src/services/pg-service.ts
    - web-ui/lib/db/repositories/schedule/dynamo.test.ts
    - web-ui/lib/db/repositories/schedule/postgres.test.ts
    - web-ui/lib/db/repositories/schedule-execution/dynamo.test.ts
    - web-ui/lib/db/repositories/schedule-execution/postgres.test.ts
    - web-ui/lib/db/repositories/audit-log/dynamo.test.ts
    - web-ui/lib/db/repositories/audit-log/postgres.test.ts
  modified:
    - web-ui/lib/db/repository-factory.ts
    - web-ui/lib/schedule-service.ts
    - web-ui/lib/schedule-execution-service.ts
    - web-ui/lib/audit-service.ts
    - lambda/scheduler/src/services/scheduler-service.ts
    - lambda/scheduler/package.json
decisions:
  - "Raw pg Pool for Lambda pg-service (not Prisma) — keeps Lambda bundle under size limit (~50KB vs 2-4MB Prisma engine)"
  - "Dual-write for schedule mutations only (create/update/delete) — reads always go through factory to the primary store"
  - "DynamoDB dual-write failures are non-fatal (console.warn) — PostgreSQL is source of truth"
  - "getAuditLogRepository() uses USE_PG_AUDIT_LOGS flag (separate from USE_PG_SCHEDULES) for independent cutover"
  - "Lambda pg-service max:3 pool + 10s idle timeout matches SCHED-06 constraint for cold-start efficiency"
  - "Schedule dynamo.test.ts: getSchedule UUID without accountId triggers 3 mock calls (2x GSI3 parallel + 1x GSI1 fallback)"
metrics:
  duration: 25min
  completed_date: "2026-03-28"
  tasks_completed: 2
  files_created: 9
  files_modified: 6
---

# Phase 03 Plan 03: Service Wiring + Lambda pg-service + Repository Tests Summary

**One-liner:** Service layer fully delegates to repository interfaces via factory functions, with dual-write for schedules, raw pg for Lambda, and 51 unit tests covering all 6 repository implementations.

## What Was Built

### Task 1: Repository factory + service delegation + Lambda pg-service

**repository-factory.ts** — Added 3 new factory functions:
- `getScheduleRepository()` — USE_PG_SCHEDULES → SchedulePostgresRepository, else ScheduleDynamoRepository
- `getScheduleExecutionRepository()` — USE_PG_SCHEDULES → ScheduleExecutionPostgresRepository, else ScheduleExecutionDynamoRepository
- `getAuditLogRepository()` — USE_PG_AUDIT_LOGS → AuditLogPostgresRepository, else AuditLogDynamoRepository

**schedule-service.ts** — Completely rewritten to delegate:
- `getSchedules`, `getSchedule` delegate to `getScheduleRepository()`
- `createSchedule`, `updateSchedule`, `deleteSchedule` implement dual-write logic (DUAL_WRITE_SCHEDULES=true)
- Audit log calls (AuditService.logUserAction) preserved as cross-cutting concern
- `buildSchedulePK`, `buildScheduleSK` re-exported for API routes that import them directly

**schedule-execution-service.ts** — Rewritten to delegate all methods to `getScheduleExecutionRepository()`.

**audit-service.ts** — Rewritten to delegate `createAuditLog` and `getAuditLogs` to `getAuditLogRepository()`. All helpers (`validateAndCleanAuditData`, `logUserAction`, `logResourceAction`, `getAuditLogStats`) preserved.

**lambda/scheduler/src/services/pg-service.ts** — New file:
- `getSchedules(tenantId)` — SELECT from schedules WHERE tenant_id = $1 AND active = true
- `logExecution(execution)` — INSERT INTO schedule_executions with 90-day expiresAt
- `closePool()` — Lambda shutdown helper
- Pool: max:3, idleTimeoutMillis:10000, connectionTimeoutMillis:5000 (SCHED-06)

**lambda/scheduler/src/services/scheduler-service.ts** — Added USE_PG_SCHEDULES flag that routes `fetchActiveSchedules()` to `pg-service.getSchedules()` when enabled.

### Task 2: Vitest unit tests for all 6 repository implementations

| File | Tests | Key assertions |
|------|-------|----------------|
| schedule/dynamo.test.ts | 11 | GSI1 query, in-memory statusFilter, searchTerm, PK/SK format, GSI1 fallback on not-found |
| schedule/postgres.test.ts | 12 | tenantId scope, active filter, ILIKE OR, pagination skip/take, create tenantId, update compound key |
| schedule-execution/dynamo.test.ts | 7 | PK TENANT#...#SCHEDULE#..., GSI1 TYPE#EXECUTION, logExecution generates exec- ID |
| schedule-execution/postgres.test.ts | 7 | expiresAt 90 days, tenantId+scheduleId WHERE, getRecentExecutions tenantId |
| audit-log/dynamo.test.ts | 6 | PutCommand to AUDIT_TABLE_NAME, expire_at 30 days, fire-and-forget, GSI2/GSI3 keys |
| audit-log/postgres.test.ts | 8 | expiresAt 30 days, fire-and-forget, tenantId WHERE, eventType filter, cross-tenant isolation |

**Total: 51 new tests, all passing.** Pre-existing failures (file-upload.test.ts + agent-executor.test.ts) unchanged at 4 failures.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] schedule/dynamo.test.ts — getSchedule not-found test needed 3 mock calls, not 2**
- **Found during:** Task 2 test execution
- **Issue:** `getSchedule('sched-not-found')` (UUID format without accountId) triggers strategy 2 (2 parallel GSI3 queries) then strategy 3 (GSI1 fallback by name) — 3 total DynamoDB calls. Initial test only provided 2 mocks.
- **Fix:** Added third `mockSend.mockResolvedValueOnce({ Items: [] })` for the GSI1 fallback
- **Files modified:** web-ui/lib/db/repositories/schedule/dynamo.test.ts
- **Commit:** 1739149

## Known Stubs

None — all repository implementations are fully wired.

## Self-Check: PASSED

- `getScheduleRepository`, `getScheduleExecutionRepository`, `getAuditLogRepository` present in repository-factory.ts: ✓
- `getScheduleRepository` used in schedule-service.ts: ✓
- `getScheduleExecutionRepository` used in schedule-execution-service.ts: ✓
- `getAuditLogRepository` used in audit-service.ts: ✓
- `lambda/scheduler/src/services/pg-service.ts` exists: ✓
- `max: 3` + `idleTimeoutMillis: 10000` in pg-service.ts: ✓
- `WHERE tenant_id = $1` in pg-service.ts getSchedules: ✓
- `DUAL_WRITE_SCHEDULES` in schedule-service.ts: ✓
- All 6 test files exist and pass (51 tests): ✓
- Lambda TypeScript compiles clean: ✓
