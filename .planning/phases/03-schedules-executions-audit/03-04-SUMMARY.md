---
phase: 03-schedules-executions-audit
plan: 04
subsystem: data-migration
tags: [migration, scripts, schedules, audit-logs, ttl-cleanup, postgresql, dynamodb]
dependency_graph:
  requires: [03-02]
  provides: [migrate-schedules, migrate-audit-logs, cleanup-expired]
  affects: [scripts/]
tech_stack:
  added: []
  patterns: [idempotent-upsert, batched-createMany, dry-run-flag, paginated-dynamodb-scan]
key_files:
  created:
    - scripts/migrate-schedules.ts
    - scripts/migrate-audit-logs.ts
    - scripts/cleanup-expired.ts
  modified: []
decisions:
  - "migrate-schedules.ts migrates both schedules (TYPE#SCHEDULE) and executions (TYPE#EXECUTION) in one script — cohesive: same source table, related entities"
  - "migrate-audit-logs.ts uses batched createMany(500) with skipDuplicates — efficient for large audit tables, idempotent ON CONFLICT DO NOTHING"
  - "cleanup-expired.ts uses DRY_RUN=true flag for safe pre-flight counting before any deletes"
  - "TTL conversion: epoch seconds (DynamoDB expire_at) → DateTime; fallback to now+30d/90d if missing or past"
metrics:
  duration: 2min
  completed_date: "2026-03-27"
  tasks_completed: 2
  files_created: 3
  files_modified: 0
requirements_fulfilled: [SCHED-09, SCHED-10, SCHED-11, MIGR-05]
---

# Phase 03 Plan 04: Data Migration Scripts Summary

**One-liner:** Three idempotent migration/maintenance scripts — schedule+execution DynamoDB upsert, audit log batched createMany(500), and PostgreSQL TTL cleanup via deleteMany(expiresAt < NOW()).

## What Was Built

Three scripts in `scripts/` completing the data migration layer for Phase 3:

| Script | Source | Destination | Pattern |
|--------|--------|-------------|---------|
| `migrate-schedules.ts` | DynamoDB GSI1 `TYPE#SCHEDULE` + `TYPE#EXECUTION` | `schedules` + `schedule_executions` | Upsert (ON CONFLICT DO UPDATE) |
| `migrate-audit-logs.ts` | DynamoDB NucleusAuditTable GSI1 `TYPE#LOG` | `audit_logs` | `createMany` batches of 500, `skipDuplicates` |
| `cleanup-expired.ts` | PostgreSQL `audit_logs` + `schedule_executions` | — (deletes) | `deleteMany(expiresAt < NOW())` |

## Tasks Completed

### Task 1: migrate-schedules.ts and migrate-audit-logs.ts (commit: f345e37)

**migrate-schedules.ts:**
- Validates `APP_TABLE_NAME` and `DATABASE_URL` (exit 1 if missing)
- Queries DynamoDB GSI1 with `gsi1pk='TYPE#SCHEDULE'` — full pagination via `LastEvaluatedKey`
- Queries DynamoDB GSI1 with `gsi1pk='TYPE#EXECUTION'` — same pagination pattern
- Upserts schedules via `prisma.schedule.upsert` on `@@unique([tenantId, scheduleId])`
- Upserts executions via `prisma.scheduleExecution.upsert` on `@@unique([tenantId, executionId])`
- TTL: `item.ttl * 1000` → DateTime; fallback to now+90d
- Prints `Migrated X/Y records...` per record, summary at end

**migrate-audit-logs.ts:**
- Validates `AUDIT_TABLE_NAME` (or `DYNAMODB_AUDIT_TABLE_NAME`) and `DATABASE_URL`
- Full pagination loop with `LastEvaluatedKey` accumulates all items
- Batched `createMany` with `BATCH_SIZE = 500` and `skipDuplicates: true`
- TTL: `item.expire_at * 1000` → DateTime; fallback to now+30d
- Prints `Migrated X/Y records...` after each batch
- Final: `Audit log migration complete. Processed: X records.`

### Task 2: cleanup-expired.ts (commit: 3b9e892)

- Validates `DATABASE_URL` (exit 1 if missing)
- `DRY_RUN=true` counts expired rows but skips deletes
- Counts expired `audit_logs` (`expiresAt < NOW()`) and prints count
- Counts expired `schedule_executions` (`expiresAt < NOW()`) and prints count
- When not dry run: `prisma.auditLog.deleteMany({ where: { expiresAt: { lt: now } } })`
- When not dry run: `prisma.scheduleExecution.deleteMany({ where: { expiresAt: { lt: now } } })`
- Prints deleted row counts per table
- Idempotent — rows already deleted can't re-appear

## Commits

| Hash | Message |
|------|---------|
| f345e37 | feat(03-schedules-executions-audit-04): add schedule and audit log migration scripts |
| 3b9e892 | feat(03-schedules-executions-audit-04): add TTL cleanup script for PostgreSQL |

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None. All scripts are complete and production-ready. They require real `DATABASE_URL` and DynamoDB access to run.

## Self-Check: PASSED

Files exist:
- FOUND: scripts/migrate-schedules.ts
- FOUND: scripts/migrate-audit-logs.ts
- FOUND: scripts/cleanup-expired.ts

Commits exist:
- FOUND: f345e37 (feat(03-schedules-executions-audit-04): add schedule and audit log migration scripts)
- FOUND: 3b9e892 (feat(03-schedules-executions-audit-04): add TTL cleanup script for PostgreSQL)
