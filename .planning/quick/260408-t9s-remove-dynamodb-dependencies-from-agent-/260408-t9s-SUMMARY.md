---
phase: quick
plan: 260408-t9s
subsystem: agent-ops
tags: [dynamodb, cleanup, agent-ops, pg-boss, scheduler]
key-files:
  modified:
    - web-ui/lib/agent-ops/scheduler-engine.ts
    - web-ui/lib/agent-ops/agent-executor.ts
    - web-ui/lib/agent-ops/executor-graphs.ts
    - web-ui/lib/agent-ops/slack-validator.ts
    - web-ui/lib/agent-ops/jira-validator.ts
    - web-ui/lib/agent-ops/slack-notifier.ts
    - web-ui/app/api/agent-ops/settings/slack/route.ts
    - web-ui/app/api/agent-ops/settings/jira/route.ts
    - web-ui/app/api/agent-ops/scheduled-tasks/[taskId]/trigger/route.ts
    - workers/src/index.ts
  created:
    - workers/src/jobs/agent-ops-scheduler/index.ts
decisions:
  - "pg-boss replaces croner for agent-ops scheduled task cron scheduling"
  - "Workers trigger execution via HTTP POST to existing trigger endpoint (keeps LangGraph in web-ui process)"
  - "Internal worker auth via x-internal-key + x-tenant-id headers bypasses NextAuth session"
  - "Queue naming: agent-ops-task:<taskId> (per-task unschedule, consistent with scheduler-scan:<tenantId>)"
metrics:
  completed: "2026-04-08"
  tasks: 2
  files-modified: 11
---

# Quick Task 260408-t9s: Remove DynamoDB from Agent-Ops, Migrate Scheduler to pg-boss

## Commits

| # | Hash | Description |
|---|------|-------------|
| 1 | f192312 | feat: migrate agent-ops scheduler from croner to pg-boss |

## What Changed

### Task 1: DynamoDB Comment Cleanup
Updated all stale DynamoDB/DDB references in 8 agent-ops files to reflect PostgreSQL reality. Comments only — no functional changes.

### Task 2: Croner → pg-boss Migration
- `scheduler-engine.ts`: Replaced croner singleton with pg-boss `schedule`/`unschedule` via `getBoss()`. `initializeScheduler()` and `shutdownScheduler()` are now no-ops (workers handle lifecycle).
- `workers/src/jobs/agent-ops-scheduler/index.ts`: New worker job that loads active tasks from PostgreSQL on startup, registers per-task pg-boss schedules, and triggers execution via HTTP POST to `/api/agent-ops/scheduled-tasks/{taskId}/trigger`.
- `trigger/route.ts`: Added `resolveTenantId()` that accepts either NextAuth session or internal worker auth (`x-internal-key` + `x-tenant-id` headers).
- `workers/src/index.ts`: Registered `agent-ops-scheduler` job.

## Verification

- Zero DynamoDB/DDB references in agent-ops module
- Zero croner references in agent-ops module
- TypeScript compiles cleanly (web-ui + workers)
- API route signatures unchanged — create/pause/resume/delete all work via same `registerTask`/`unregisterTask` exports
