---
phase: 22-executor-abstraction-foundation
plan: 01
subsystem: workers
tags: [pg-boss, executor, vertical, horizontal, factory, typescript, vitest]

requires:
  - phase: pg-boss-migration
    provides: workers/ directory with pg-boss job infrastructure

provides:
  - JobExecutor interface and HandlerFn type (workers/src/executor/types.ts)
  - VerticalExecutor — Map-based in-process handler dispatch
  - HorizontalExecutor — no-op stub for future ECS dispatch (Phase 24)
  - createExecutor factory — selects implementation by WORKER_ARCH env value
  - workers/src/lib/logger.ts — createLogger(service) factory for structured logging

affects: [22-02, 23-job-registration, 24-ecs-dispatch]

tech-stack:
  added: []
  patterns:
    - "Pluggable executor strategy: JobExecutor interface + factory pattern keyed on WORKER_ARCH"
    - "Optional registerHandler? on interface — job files call it without importing VerticalExecutor directly"
    - "No try/catch in VerticalExecutor.execute() — errors propagate transparently; pg-boss retryLimit handles retries"

key-files:
  created:
    - workers/src/executor/types.ts
    - workers/src/executor/vertical.ts
    - workers/src/executor/horizontal.ts
    - workers/src/executor/factory.ts
    - workers/src/executor/index.ts
    - workers/src/executor/vertical.test.ts
    - workers/src/executor/factory.test.ts
    - workers/src/lib/logger.ts
  modified: []

key-decisions:
  - "registerHandler? is optional on JobExecutor interface — avoids forcing HorizontalExecutor to implement it and lets job files call it without importing VerticalExecutor directly"
  - "VerticalExecutor propagates handler errors without wrapping — pg-boss retryLimit handles retries at the queue level"
  - "HorizontalExecutor must NOT throw — Phase 24 replaces the body with ECS RunTask"
  - "workers/src/lib/logger.ts created as Rule 3 fix — plan referenced createLogger but file did not exist"

patterns-established:
  - "Executor pattern: createExecutor(arch) factory returns JobExecutor; consumers never import concrete classes"
  - "createLogger('service-name') from workers/src/lib/logger.ts for all structured logging in workers/"

requirements-completed: [EXEC-02, EXEC-03]

duration: 4min
completed: 2026-04-09
---

# Phase 22 Plan 01: Executor Abstraction Foundation Summary

**JobExecutor interface + VerticalExecutor (Map-based in-process dispatch) + HorizontalExecutor (no-op stub) + createExecutor factory, with 7 passing unit tests.**

## Performance

- **Duration:** ~4 min
- **Started:** 2026-04-09T03:53:16Z
- **Completed:** 2026-04-09T03:56:24Z
- **Tasks:** 2
- **Files modified:** 8

## Accomplishments

- Created `workers/src/executor/` module with 5 files: types, vertical, horizontal, factory, barrel
- 7 unit tests pass covering all executor behaviors (dispatch, error propagation, factory selection)
- Created `workers/src/lib/logger.ts` with `createLogger(service)` factory (Rule 3 fix — missing dependency)

## Task Commits

1. **Task 1: executor module** - `f406159` (feat)
2. **Task 2: unit tests** - `9e0e4f4` (test)

## Files Created/Modified

- `workers/src/executor/types.ts` — JobExecutor interface, HandlerFn type
- `workers/src/executor/vertical.ts` — VerticalExecutor with Map registry
- `workers/src/executor/horizontal.ts` — HorizontalExecutor no-op stub
- `workers/src/executor/factory.ts` — createExecutor factory
- `workers/src/executor/index.ts` — barrel re-exports
- `workers/src/executor/vertical.test.ts` — 4 tests for VerticalExecutor
- `workers/src/executor/factory.test.ts` — 3 tests for createExecutor
- `workers/src/lib/logger.ts` — createLogger(service) structured logger

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Created missing workers/src/lib/logger.ts**
- **Found during:** Task 1
- **Issue:** Plan imports `createLogger` from `../lib/logger.js` but `workers/src/lib/` directory and `logger.ts` did not exist
- **Fix:** Created `workers/src/lib/logger.ts` with `createLogger(service)` factory matching the expected API
- **Files modified:** `workers/src/lib/logger.ts`
- **Commit:** f406159

## Self-Check: PASSED

- `workers/src/executor/types.ts` — FOUND
- `workers/src/executor/vertical.ts` — FOUND
- `workers/src/executor/horizontal.ts` — FOUND
- `workers/src/executor/factory.ts` — FOUND
- `workers/src/executor/index.ts` — FOUND
- `workers/src/executor/vertical.test.ts` — FOUND
- `workers/src/executor/factory.test.ts` — FOUND
- `workers/src/lib/logger.ts` — FOUND
- Commit f406159 — FOUND
- Commit 9e0e4f4 — FOUND
- 7/7 tests pass
