---
phase: 22-executor-abstraction-foundation
plan: 02
subsystem: workers
tags: [pg-boss, executor, wiring, entrypoint, scheduler, kb-sync, typescript, vitest]

requires:
  - phase: 22-01
    provides: JobExecutor interface, VerticalExecutor, HorizontalExecutor, createExecutor factory, createLogger

provides:
  - workers/src/index.ts wired with createExecutor + createLogger
  - scheduler register() accepts JobExecutor, routes boss.work through executor.execute
  - kb-sync register() accepts JobExecutor, routes boss.work through executor.execute
  - 6 new tests covering executor integration in both job modules

affects: [23-job-registration, 24-ecs-dispatch]

tech-stack:
  added: []
  patterns:
    - "register(boss, executor) signature — all job modules accept JobExecutor as second param"
    - "executor.registerHandler?(name, fn) + executor.execute(name, data) in boss.work callback"
    - "createLogger(service) replaces all console.log/error in workers entrypoint and job modules"

key-files:
  created: []
  modified:
    - workers/src/index.ts
    - workers/src/jobs/scheduler/index.ts
    - workers/src/jobs/kb-sync/index.ts
    - workers/src/jobs/scheduler/index.test.ts
    - workers/src/jobs/kb-sync/index.test.ts

key-decisions:
  - "register(boss, executor) — executor passed as second param, not imported globally, keeps job modules testable"
  - "Error handling stays in boss.work callback for kb-sync (updateDS on failure) — executor.execute only runs the happy path"
  - "Pre-existing dynamodb-service.test.ts failure (TENANT#undefined) is out of scope — not caused by 22-02 changes"

requirements-completed: [EXEC-04, EXEC-05]

duration: 12min
completed: 2026-04-09
---

# Phase 22 Plan 02: Wire Executor into Entrypoint + Job Registration Summary

**Executor wired into workers entrypoint and both job register() functions updated to accept JobExecutor, route boss.work callbacks through executor.execute(), and use structured logging.**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-04-09T04:10:09Z
- **Completed:** 2026-04-09T04:23:50Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments

- Updated `workers/src/index.ts` to create executor from `WORKER_ARCH` env and pass it to both register() calls
- Updated `workers/src/jobs/scheduler/index.ts` — accepts `JobExecutor`, calls `registerHandler` + `execute`
- Updated `workers/src/jobs/kb-sync/index.ts` — accepts `JobExecutor`, calls `registerHandler` + `execute`
- Replaced all `console.log/error` with `createLogger(service)` in entrypoint and both job modules
- 6 new tests pass (3 scheduler + 3 kb-sync) covering registerHandler and execute integration

## Task Commits

1. **Task 1: wire executor into entrypoint** — `b12d0f4` (feat)
2. **Task 2: update job register() functions** — `1c425e5` (feat)

(Prerequisite: 22-01 executor module cherry-picked as `06e3cdd`)

## Files Modified

- `workers/src/index.ts` — createExecutor + createLogger, executor passed to register calls
- `workers/src/jobs/scheduler/index.ts` — executor param, registerHandler + execute, structured logging
- `workers/src/jobs/kb-sync/index.ts` — executor param, registerHandler + execute, structured logging
- `workers/src/jobs/scheduler/index.test.ts` — mockExecutor, 3 tests (cron, registerHandler, execute)
- `workers/src/jobs/kb-sync/index.test.ts` — mockExecutor, 3 tests (worker, registerHandler, execute)

## Deviations from Plan

### Auto-fixed Issues

None — plan executed exactly as written.

### Out-of-Scope Issues Noted

**Pre-existing test failure: `dynamodb-service.test.ts`**
- `TENANT#undefined#SCHEDULE#sched-123` vs expected `TENANT#default#SCHEDULE#sched-123`
- Pre-dates 22-02 changes; not caused by executor wiring
- Logged to deferred-items for future fix

## Known Stubs

None — all executor wiring is fully functional. HorizontalExecutor is an intentional stub (Phase 24 will replace it with ECS RunTask dispatch).

## Self-Check: PASSED

- `workers/src/index.ts` — FOUND, uses createExecutor + createLogger
- `workers/src/jobs/scheduler/index.ts` — FOUND, accepts executor param
- `workers/src/jobs/kb-sync/index.ts` — FOUND, accepts executor param
- `workers/src/jobs/scheduler/index.test.ts` — FOUND, 3 tests pass
- `workers/src/jobs/kb-sync/index.test.ts` — FOUND, 3 tests pass
- Commit b12d0f4 — FOUND
- Commit 1c425e5 — FOUND
- 15/16 tests pass (1 pre-existing failure unrelated to this plan)
