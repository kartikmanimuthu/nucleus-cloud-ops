---
phase: 23-job-wiring-runner-entrypoint
plan: "01"
subsystem: workers
tags: [pg-boss, executor, discovery, agent-ops, job-wiring]
dependency_graph:
  requires: [22-executor-abstraction-foundation]
  provides: [all-4-jobs-wired-through-executor]
  affects: [workers/src/index.ts, workers/src/jobs/discovery, workers/src/jobs/agent-ops-scheduler]
tech_stack:
  added: []
  patterns: [executor-delegation, exported-handler-fn, dual-queue-fan-out]
key_files:
  created: []
  modified:
    - workers/src/jobs/discovery/index.ts
    - workers/src/jobs/agent-ops-scheduler/index.ts
    - workers/src/index.ts
decisions:
  - "Discovery fan-out stays as direct boss.work — it calls boss.send() for orchestration, not execution; only discovery-scan delegates through executor"
  - "handleAgentOpsTick does not take boss param — it only does HTTP POST, so the old handleTick(boss, job) signature was unnecessary"
  - "executor.registerHandler? called per dynamic queue in agent-ops loop — each task queue gets its own handler registration"
metrics:
  duration: "156s"
  completed_date: "2026-04-09"
  tasks_completed: 2
  files_modified: 3
---

# Phase 23 Plan 01: Job Wiring Runner Entrypoint Summary

**One-liner:** Discovery and agent-ops-scheduler jobs wired through JobExecutor abstraction; all 4 job modules registered in workers entrypoint via register(boss, executor) pattern.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Wire discovery job through executor abstraction | d9d1f3d | workers/src/jobs/discovery/index.ts |
| 2 | Wire agent-ops-scheduler + register all 4 in entrypoint | 6a36745 | workers/src/jobs/agent-ops-scheduler/index.ts, workers/src/index.ts |

## What Was Built

**Task 1 — Discovery job:**
- Extracted `handleDiscoveryScan(jobData: unknown)` as an exported standalone function containing the full scan logic (account iteration, STS assume-role, inventory scan, pg write, vector processing, audit log)
- `register(boss, executor)` now accepts `JobExecutor` as second param
- `executor.registerHandler?.('discovery-scan', handleDiscoveryScan)` called at top of register
- `boss.work('discovery-scan', ...)` callback replaced with single `executor.execute('discovery-scan', job.data)` delegation
- Fan-out `boss.work('discovery-fan-out', ...)` stays inline — it calls `boss.send()` directly and is orchestration, not execution

**Task 2 — Agent-ops-scheduler + entrypoint:**
- Extracted `handleAgentOpsTick(jobData: unknown)` as exported standalone function (HTTP POST to web-ui trigger endpoint)
- Removed old `handleTick(boss, job)` — boss param was unused
- `TaskTickData` interface exported
- `register(boss, executor)` accepts executor; per-task loop calls `executor.registerHandler?(queue, handleAgentOpsTick)` and delegates via `executor.execute(queue, job.data)`
- `workers/src/index.ts` imports and registers all 4 job modules: scheduler, kb-sync, discovery, agent-ops-scheduler

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Self-Check: PASSED

- `workers/src/jobs/discovery/index.ts` — modified, contains `export async function handleDiscoveryScan`
- `workers/src/jobs/agent-ops-scheduler/index.ts` — modified, contains `export async function handleAgentOpsTick`
- `workers/src/index.ts` — modified, registers all 4 jobs
- Commits d9d1f3d and 6a36745 exist in git log
- `npx tsc --noEmit` passes with zero errors
