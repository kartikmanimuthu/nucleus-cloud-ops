---
phase: 03-schedules-executions-audit
plan: 02
subsystem: repository-layer
tags: [repository-pattern, dynamodb, postgresql, schedule, audit-log, multi-tenant]
dependency_graph:
  requires: [03-01]
  provides: [IScheduleRepository, IScheduleExecutionRepository, IAuditLogRepository]
  affects: [03-03]
tech_stack:
  added: []
  patterns:
    - "Repository pattern (interface + DynamoDB + PostgreSQL per entity)"
    - "Fire-and-forget audit logging (catch + swallow in createAuditLog)"
    - "Prisma client singleton via getPrismaClient() from pg-config.ts"
    - "Server-side WHERE tenantId scoping on all PostgreSQL queries"
key_files:
  created:
    - web-ui/lib/db/repositories/schedule/interface.ts
    - web-ui/lib/db/repositories/schedule/dynamo.ts
    - web-ui/lib/db/repositories/schedule/postgres.ts
    - web-ui/lib/db/repositories/schedule-execution/interface.ts
    - web-ui/lib/db/repositories/schedule-execution/dynamo.ts
    - web-ui/lib/db/repositories/schedule-execution/postgres.ts
    - web-ui/lib/db/repositories/audit-log/interface.ts
    - web-ui/lib/db/repositories/audit-log/dynamo.ts
    - web-ui/lib/db/repositories/audit-log/postgres.ts
  modified: []
decisions:
  - "ScheduleDynamoRepository preserves GSI1 TYPE#SCHEDULE in-memory filter pattern — identical DynamoDB path behaviour maintained"
  - "ScheduleExecutionPostgresRepository sets expiresAt = now + 90 days replacing DynamoDB TTL"
  - "AuditLogPostgresRepository sets expiresAt = now + 30 days matching DynamoDB expire_at retention"
  - "AuditLogPostgresRepository adds tenantId scoping on getAuditLogs — DynamoDB path has no tenant filter (original audit table design)"
  - "resourceFilter applied in-memory in SchedulePostgresRepository — resources is a Json column without indexable type sub-fields"
metrics:
  duration: 6min
  completed_date: "2026-03-27"
  tasks_completed: 1
  files_created: 9
  files_modified: 0
---

# Phase 03 Plan 02: Schedule, Execution, and AuditLog Repository Layer Summary

## One-liner

Dual-backend repository layer (DynamoDB + PostgreSQL) for Schedule, ScheduleExecution, and AuditLog entities with mandatory tenantId scoping and TTL-via-expiresAt on both new PostgreSQL repositories.

## What Was Built

9 TypeScript files across 3 repository directories:

### Schedule Repository

- **interface.ts** — `IScheduleRepository` with `ScheduleFilters`, `SchedulePage` exports
- **dynamo.ts** — `ScheduleDynamoRepository` preserving GSI1 `TYPE#SCHEDULE` list query + in-memory filter + GSI3 UUID status lookup
- **postgres.ts** — `SchedulePostgresRepository` with server-side WHERE/ILIKE + mandatory `WHERE tenantId` on every query

### ScheduleExecution Repository

- **interface.ts** — `IScheduleExecutionRepository` with `logExecution`, `getExecutionHistory`, `getRecentExecutions`
- **dynamo.ts** — `ScheduleExecutionDynamoRepository` preserving `PK=TENANT#<t>#SCHEDULE#<s>`, `SK=EXEC#<ts>#<id>`, GSI1 TYPE#EXECUTION pattern
- **postgres.ts** — `ScheduleExecutionPostgresRepository` with `expiresAt = now + 90 days` on every insert

### AuditLog Repository

- **interface.ts** — `IAuditLogRepository` with fire-and-forget `createAuditLog` + `getAuditLogs`
- **dynamo.ts** — `AuditLogDynamoRepository` preserving GSI1/GSI2/GSI3 strategy (global time / by user / by event type) + cursor pagination
- **postgres.ts** — `AuditLogPostgresRepository` with `expiresAt = now + 30 days` + server-side filter for status, severity, eventType, user + tenantId scoping

## Decisions Made

1. **ScheduleDynamoRepository preserves GSI1 in-memory filter** — identical DynamoDB path behaviour required; server-side filtering only added in Postgres path.

2. **ScheduleExecutionPostgresRepository: expiresAt = now + 90 days** — replaces DynamoDB `ttl` epoch field; cleanup-expired.ts handles purging via `WHERE expiresAt < NOW()`.

3. **AuditLogPostgresRepository: expiresAt = now + 30 days** — matches DynamoDB `expire_at` 30-day retention; consistent audit lifecycle across backends.

4. **AuditLogPostgresRepository adds tenantId to getAuditLogs** — DynamoDB audit path has no tenant filter (original design). PostgreSQL path adds `WHERE tenantId` for multi-tenant safety. The tenantId param is accepted but noted as new behaviour vs DynamoDB.

5. **resourceFilter applied in-memory in SchedulePostgresRepository** — `resources` is a JSON column; filtering by resource type sub-field requires either a generated column/index or in-memory filtering. In-memory filter applied after Prisma query to avoid raw SQL.

6. **AuditLogPostgresRepository.createAuditLog falls back to 'org-default' tenantId** — callers (AuditService.createAuditLog) don't currently pass tenantId. Fall-back ensures existing callers work before Plan 03-03 wires tenantId through.

## Deviations from Plan

None — plan executed exactly as written.

## TypeScript Compilation

```
cd web-ui && npx tsc --noEmit --skipLibCheck
# Result: 0 errors in schedule/schedule-execution/audit-log directories
```

## Commits

| Task | Description | Hash | Files |
|------|-------------|------|-------|
| 1 | feat(03-02): add schedule, execution, and audit-log repository layer | adbbdf4 | 9 files |

## Self-Check

### Files exist:
- [x] web-ui/lib/db/repositories/schedule/interface.ts
- [x] web-ui/lib/db/repositories/schedule/dynamo.ts
- [x] web-ui/lib/db/repositories/schedule/postgres.ts
- [x] web-ui/lib/db/repositories/schedule-execution/interface.ts
- [x] web-ui/lib/db/repositories/schedule-execution/dynamo.ts
- [x] web-ui/lib/db/repositories/schedule-execution/postgres.ts
- [x] web-ui/lib/db/repositories/audit-log/interface.ts
- [x] web-ui/lib/db/repositories/audit-log/dynamo.ts
- [x] web-ui/lib/db/repositories/audit-log/postgres.ts

### Commit exists: adbbdf4 — FOUND

## Self-Check: PASSED
