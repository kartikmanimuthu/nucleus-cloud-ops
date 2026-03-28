---
phase: 04-kb-inventory-agent-ops
plan: 01
subsystem: database
tags: [prisma, postgresql, migration, knowledge-base, inventory, agent-ops]

requires:
  - phase: 03-schedules-executions-audit
    provides: AuditLog model and migration pattern established

provides:
  - KnowledgeBase and DataSource Prisma models (knowledge_bases, data_sources tables)
  - InventoryResource Prisma model with JSONB tags/metadata (inventory_resources table)
  - AgentOpsRun and AgentOpsEvent Prisma models with TTL expiresAt (agent_ops_runs, agent_ops_events tables)
  - ScheduledTask and ScheduledTaskLock Prisma models (scheduled_tasks, scheduled_task_locks tables)
  - Migration 20260328060046_phase04_kb_inventory_agent_ops applied to local PostgreSQL
  - Prisma client regenerated with all 7 new models

affects: [04-02, 04-03, 04-04, 04-05, 04-06, 04-07]

tech-stack:
  added: []
  patterns:
    - "expiresAt DateTime for TTL replacement on AgentOpsRun and AgentOpsEvent (30-day retention)"
    - "ScheduledTaskLock uses @@unique([taskId, scheduledAt]) for atomic ON CONFLICT lock acquisition"
    - "InventoryResource uses flat table with JSONB tags/metadata columns for flexible resource attributes"
    - "AgentOpsEvent relates to AgentOpsRun via composite FK (tenantId, runId) for cascade delete"

key-files:
  created:
    - prisma/migrations/20260328060046_phase04_kb_inventory_agent_ops/migration.sql
  modified:
    - prisma/schema.prisma

key-decisions:
  - "InventoryResource uses flat table with JSONB metadata/tags — avoids EAV complexity, enables JSONB operators for filtering"
  - "AgentOpsEvent FK references composite (tenantId, runId) on AgentOpsRun — enables tenant-scoped cascade delete without cross-tenant leakage"
  - "ScheduledTaskLock has no tenantId — lock is per-task execution slot, not per-tenant; taskId already encodes tenant scope"
  - "migrate diff --shadow-database-url used (not --from-migrations-directory) — correct Prisma 5 flag name"
  - "Baseline existing 3 migrations via migrate resolve --applied before deploying Phase 4 — database had tables but no _prisma_migrations tracking"

patterns-established:
  - "Composite FK pattern: AgentOpsEvent.run references (tenantId, runId) for tenant-safe cascade"
  - "Lock table pattern: ScheduledTaskLock with @@unique([taskId, scheduledAt]) for idempotent cron execution"

requirements-completed: [KB-01, KB-05, AOPS-01]

duration: 12min
completed: 2026-03-28
---

# Phase 4 Plan 01: KB/Inventory/Agent Ops Schema Summary

**7 Prisma models (KnowledgeBase, DataSource, InventoryResource, AgentOpsRun, AgentOpsEvent, ScheduledTask, ScheduledTaskLock) added to schema and migrated to PostgreSQL with CHECK constraints**

## Performance

- **Duration:** 12 min
- **Started:** 2026-03-28T05:50:00Z
- **Completed:** 2026-03-28T06:02:00Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- 7 new Prisma models appended to schema.prisma following established conventions (plain tenantId, @@map, cuid ids)
- Migration SQL generated via `prisma migrate diff` and applied to local PostgreSQL
- CHECK constraints added for all enum-like string columns (status, sourceType, source, mode, eventType, taskStatus)
- Prisma client regenerated with all new models accessible

## Task Commits

1. **Task 1: Add Phase 4 Prisma models to schema.prisma** - `fa4f5ec` (feat)
2. **Task 2: Generate and apply Prisma migration** - `dfcbab5` (feat)

## Files Created/Modified
- `prisma/schema.prisma` - 7 new models appended after AuditLog (183 lines added)
- `prisma/migrations/20260328060046_phase04_kb_inventory_agent_ops/migration.sql` - 7 CREATE TABLE statements + indexes + FK constraints + 9 CHECK constraints

## Decisions Made
- InventoryResource uses flat table with JSONB metadata/tags — avoids EAV complexity, enables JSONB operators
- AgentOpsEvent FK references composite (tenantId, runId) — tenant-safe cascade delete
- ScheduledTaskLock has no tenantId — lock is per-task execution slot; taskId already encodes tenant scope
- Used `--shadow-database-url` flag (not `--from-migrations-directory`) — correct Prisma 5 CLI flag name
- Baselined existing 3 migrations via `migrate resolve --applied` before deploying — database had tables but no `_prisma_migrations` tracking table

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Baselined existing migrations before deploying Phase 4**
- **Found during:** Task 2 (migrate deploy)
- **Issue:** `prisma migrate deploy` returned P3005 "database schema is not empty" — existing tables present but no `_prisma_migrations` tracking
- **Fix:** Ran `prisma migrate resolve --applied` for all 3 prior migrations to baseline them
- **Files modified:** None (database state only)
- **Verification:** `migrate deploy` applied Phase 4 migration successfully after baselining
- **Committed in:** dfcbab5 (Task 2 commit)

**2. [Rule 3 - Blocking] Used correct prisma migrate diff flag**
- **Found during:** Task 2 (migrate diff)
- **Issue:** Plan specified `--from-migrations-directory` but Prisma 5 uses `--from-migrations`
- **Fix:** Used `--from-migrations prisma/migrations --shadow-database-url` (correct Prisma 5 syntax)
- **Files modified:** None
- **Verification:** SQL diff generated successfully
- **Committed in:** dfcbab5 (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (2 blocking)
**Impact on plan:** Both fixes were necessary to complete the migration. No scope creep.

## Issues Encountered
- Missing `.env` file with DATABASE_URL — created from docker-compose credentials (postgresql://nucleus:nucleus_dev@localhost:5432/nucleus)

## Next Phase Readiness
- All 7 Phase 4 tables exist in PostgreSQL with correct columns, indexes, and CHECK constraints
- Prisma client has KnowledgeBase, DataSource, InventoryResource, AgentOpsRun, AgentOpsEvent, ScheduledTask, ScheduledTaskLock models
- Ready for Plan 04-02 (KB repository layer) and parallel plans

---
*Phase: 04-kb-inventory-agent-ops*
*Completed: 2026-03-28*
