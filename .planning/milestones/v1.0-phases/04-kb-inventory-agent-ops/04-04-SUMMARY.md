---
phase: 04-kb-inventory-agent-ops
plan: 04
subsystem: agent-ops-repositories
tags: [repository-pattern, agent-ops, scheduled-tasks, migration, tdd, postgresql, dynamodb]
dependency_graph:
  requires: [04-01]
  provides: [IAgentOpsRunRepository, IAgentOpsEventRepository, IScheduledTaskRepository, migrate-kb, migrate-agent-ops]
  affects: [agent-ops-service, scheduled-task-service, repository-factory]
tech_stack:
  added: []
  patterns: [repository-pattern, feature-flags, ON-CONFLICT-lock, JSON-path-filtering, TDD]
key_files:
  created:
    - web-ui/lib/db/repositories/agent-ops-run/interface.ts
    - web-ui/lib/db/repositories/agent-ops-run/dynamo.ts
    - web-ui/lib/db/repositories/agent-ops-run/postgres.ts
    - web-ui/lib/db/repositories/agent-ops-run/dynamo.test.ts
    - web-ui/lib/db/repositories/agent-ops-run/postgres.test.ts
    - web-ui/lib/db/repositories/agent-ops-event/interface.ts
    - web-ui/lib/db/repositories/agent-ops-event/dynamo.ts
    - web-ui/lib/db/repositories/agent-ops-event/postgres.ts
    - web-ui/lib/db/repositories/agent-ops-event/dynamo.test.ts
    - web-ui/lib/db/repositories/agent-ops-event/postgres.test.ts
    - web-ui/lib/db/repositories/scheduled-task/interface.ts
    - web-ui/lib/db/repositories/scheduled-task/dynamo.ts
    - web-ui/lib/db/repositories/scheduled-task/postgres.ts
    - web-ui/lib/db/repositories/scheduled-task/dynamo.test.ts
    - web-ui/lib/db/repositories/scheduled-task/postgres.test.ts
    - scripts/migrate-kb.ts
    - scripts/migrate-agent-ops.ts
  modified:
    - web-ui/lib/db/repository-factory.ts
decisions:
  - "AgentOpsRunPostgresRepository.findAwaitingApprovalRun uses single WHERE query instead of scanning 3 sources x 100 records (AOPS-06)"
  - "ScheduledTaskPostgresRepository.tryAcquireExecutionLock uses ON CONFLICT (taskId, scheduledAt) DO NOTHING for atomic lock acquisition (AOPS-04)"
  - "AgentOpsEventPostgresRepository.recordEvent never throws — failures logged only, matching existing DynamoDB behavior"
  - "migrate-agent-ops.ts uses full table scan (AgentOpsTable has no GSI covering all item types)"
  - "migrate-kb.ts builds kbId->tenantId map from KB records before migrating DataSources (DataSource PK=KB#<id> has no tenantId)"
metrics:
  duration: 11min
  completed: 2026-03-28
  tasks: 2
  files: 18
---

# Phase 4 Plan 4: Agent Ops Repositories + Migration Scripts Summary

Agent ops data layer migration complete: 3 repository sets (AgentOpsRun, AgentOpsEvent, ScheduledTask) with interface + DynamoDB + PostgreSQL implementations, 33 TDD tests, factory wiring via USE_PG_AGENT_OPS, and migration scripts for KB and agent ops data.

## Tasks Completed

| Task | Description | Commit | Tests |
|------|-------------|--------|-------|
| 1 | AgentOpsRun + AgentOpsEvent + ScheduledTask repositories with TDD | 779a854 | 33 pass |
| 2 | Data migration scripts for KB + agent ops | b872aa1 | — |

## Key Improvements Over DynamoDB

- `findAwaitingApprovalRun(runId)`: single `WHERE runId + status` query instead of scanning 3 sources x 100 records (AOPS-06)
- `findAwaiting*ByJiraIssue` / `findAwaitingRunBySlackThread`: Prisma JSON path filtering on `trigger` column instead of in-memory scan
- `listRuns(query)`: server-side `WHERE source/status` + `ORDER BY createdAt DESC` + `LIMIT` instead of parallel GSI queries + in-memory merge
- `tryAcquireExecutionLock`: `ON CONFLICT (taskId, scheduledAt) DO NOTHING` for atomic distributed lock (AOPS-04)
- `listScheduledTasks`: `WHERE taskStatus != 'deleted'` server-side instead of in-memory filter

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None — all repository methods fully implemented.

## Self-Check: PASSED

Files verified:
- web-ui/lib/db/repositories/agent-ops-run/interface.ts — FOUND
- web-ui/lib/db/repositories/agent-ops-run/postgres.ts — FOUND
- web-ui/lib/db/repositories/scheduled-task/postgres.ts — FOUND
- scripts/migrate-kb.ts — FOUND
- scripts/migrate-agent-ops.ts — FOUND

Commits verified:
- 779a854 — FOUND (Task 1: repositories)
- b872aa1 — FOUND (Task 2: migration scripts)

Tests: 33/33 passing
