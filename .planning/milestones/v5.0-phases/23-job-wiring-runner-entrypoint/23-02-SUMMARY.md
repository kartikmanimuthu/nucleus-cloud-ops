---
phase: 23-job-wiring-runner-entrypoint
plan: "02"
subsystem: workers
tags: [job-runner, cli, ecs-fargate, vertical-executor, pg-boss-free]
dependency_graph:
  requires: ["23-01"]
  provides: ["workers/src/job-runner.ts", "dist/job-runner.js"]
  affects: ["workers/package.json"]
tech_stack:
  added: []
  patterns: ["CLI arg parsing via process.argv", "VerticalExecutor dispatch without pg-boss", "dynamic agent-ops-task:* prefix routing"]
key_files:
  created:
    - workers/src/job-runner.ts
  modified:
    - workers/src/jobs/scheduler/index.ts
    - workers/src/jobs/kb-sync/index.ts
    - workers/package.json
decisions:
  - "Manual process.argv parsing — zero extra dependencies for 2 CLI args"
  - "HANDLERS map for well-known jobs; dynamic agent-ops-task:* detection via prefix check"
  - "process.exit(0/1) handles Prisma connection cleanup implicitly — no manual teardown"
metrics:
  duration: "~10 minutes"
  completed: "2026-04-09"
  tasks: 2
  files: 4
---

# Phase 23 Plan 02: Job Runner Entrypoint Summary

Standalone CLI entrypoint `job-runner.ts` that dispatches any job handler by name via VerticalExecutor without pg-boss.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Export handler functions from scheduler and kb-sync | c0dc199 | workers/src/jobs/scheduler/index.ts, workers/src/jobs/kb-sync/index.ts |
| 2 | Create job-runner.ts entrypoint and add npm script | c7e2a32 | workers/src/job-runner.ts, workers/package.json |

## What Was Built

`workers/src/job-runner.ts` — a pg-boss-free CLI entrypoint for ECS Fargate ephemeral tasks:

- Parses `--job <name>` and `--data '<json>'` from `process.argv`
- Registers all 4 handlers into a `VerticalExecutor` instance
- Handles dynamic `agent-ops-task:<taskId>` queue names via prefix check
- Exits `0` on success, `1` on failure
- `npm run start:job-runner` script: `node --env-file=.env dist/job-runner.js`

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Self-Check: PASSED

- workers/src/job-runner.ts: FOUND
- workers/dist/job-runner.js: FOUND (compiled)
- c0dc199: FOUND
- c7e2a32: FOUND
