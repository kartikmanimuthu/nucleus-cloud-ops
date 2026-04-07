---
phase: quick
plan: 260407-dqr
subsystem: workers/logging
tags: [logging, structured-logger, kb-sync, discovery, refactor]
dependency_graph:
  requires: []
  provides: [workers/src/lib/logger.ts]
  affects: [workers/src/jobs/kb-sync, workers/src/jobs/discovery]
tech_stack:
  added: []
  patterns: [createLogger factory, level-gated console wrapper, structured JSON metadata]
key_files:
  created:
    - workers/src/lib/logger.ts
  modified:
    - workers/.env.example
    - workers/src/jobs/kb-sync/index.ts
    - workers/src/jobs/kb-sync/handlers/s3-sync.ts
    - workers/src/jobs/kb-sync/handlers/confluence-sync.ts
    - workers/src/jobs/kb-sync/handlers/bitbucket-sync.ts
    - workers/src/jobs/discovery/index.ts
    - workers/src/jobs/discovery/services/scanner.ts
    - workers/src/jobs/discovery/services/custom-scanners.ts
    - workers/src/jobs/discovery/services/pg-writer.ts
    - workers/src/jobs/discovery/services/vector-processor.ts
    - workers/src/jobs/discovery/services/audit-service.ts
    - workers/src/jobs/discovery/services/account-service.ts
decisions:
  - Zero-dependency console wrapper chosen — no pino/winston to keep Lambda bundle small
  - Level read once at module load (not per-call) for performance
  - local-runner.ts console calls intentionally left — it is a dev CLI tool, not a worker
  - audit-service.ts and account-service.ts migrated as deviation (Rule 2) — same directory, same correctness requirement
metrics:
  duration: ~15min
  completed: 2026-04-07
  tasks_completed: 2
  files_modified: 13
---

# Phase quick Plan 260407-dqr: Refactor Logging to Industry Standard Logger Summary

Zero-dependency structured logger (`createLogger` factory) added to `workers/src/lib/logger.ts`; all 11 worker files in kb-sync and discovery migrated from raw `console.*` to level-gated structured output with ISO timestamps, module prefixes, and JSON metadata. No sensitive data (tokens, ARNs, connection strings) appears in any log call.

## Tasks Completed

| # | Task | Commit |
|---|------|--------|
| 1 | Create shared logger module + LOG_LEVEL env var | c411a08 |
| 2 | Migrate all console calls in kb-sync and discovery | d1bff6c |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing] Migrated audit-service.ts and account-service.ts**
- **Found during:** Task 2 verification grep
- **Issue:** `audit-service.ts` and `account-service.ts` had raw `console.error` calls in the same `discovery/services/` directory — the plan listed them as out of scope but the done criteria required zero console calls in `workers/src/jobs/discovery/`
- **Fix:** Added `createLogger` to both files, replaced 4 console.error calls with structured logger
- **Files modified:** `workers/src/jobs/discovery/services/audit-service.ts`, `workers/src/jobs/discovery/services/account-service.ts`
- **Commit:** d1bff6c

**2. [Rule 2 - Scope] local-runner.ts console calls intentionally left**
- `workers/src/jobs/discovery/local-runner.ts` is a developer CLI tool (not a worker job). Its console output is intentional user-facing output, not operational logging. Left as-is.

## Known Stubs

None.

## Self-Check: PASSED

- `workers/src/lib/logger.ts` — FOUND
- Commit c411a08 — FOUND
- Commit d1bff6c — FOUND
- Zero console calls in kb-sync/ and discovery/ (excluding local-runner.ts) — VERIFIED
- TypeScript compiles clean — VERIFIED
