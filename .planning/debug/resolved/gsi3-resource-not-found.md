---
status: resolved
trigger: "Workers scheduler job fails with ResourceNotFoundException when querying DynamoDB GSI3 in fetchScheduleById"
created: 2026-04-05T00:00:00Z
updated: 2026-04-05T00:01:00Z
---

## Current Focus
<!-- OVERWRITE on each update - reflects NOW -->

hypothesis: CONFIRMED — runPartialScan calls fetchScheduleById (DynamoDB) unconditionally, not gated by USE_PG_SCHEDULES. workers/.env has USE_PG_SCHEDULES=true, so DynamoDB table/GSI3 is not expected to exist in this environment.
test: Verified by reading scheduler-service.ts line 227 (unconditional DynamoDB call) vs lines 77-166 (full scan correctly branches on USE_PG_SCHEDULES)
expecting: Fix: add getScheduleById to pg-service.ts, gate the call in runPartialScan
next_action: Apply fix

## Symptoms
<!-- Written during gathering, then IMMUTABLE -->

expected: Partial scan for schedule `sched-1775284152179-9gxf3c9o5` should find the schedule via GSI3 and proceed with execution.
actual: Both GSI3 queries (status: active, status: inactive) throw `ResourceNotFoundException`, then log "Schedule not found in GSI3". Job retries 3+ times with same result.
errors: |
  ResourceNotFoundException: Requested resource not found
  at fetchScheduleById (workers/src/jobs/scheduler/services/dynamodb-service.ts:112)
  at runPartialScan (workers/src/jobs/scheduler/services/scheduler-service.ts:227)
  
  The error fires for BOTH status queries (active + inactive), suggesting the table or GSI itself doesn't exist — not just a missing item.
reproduction: Run `cd workers && npm run dev` — any partial scan job triggers it immediately.
timeline: On branch `pg-boss-migration`. New workers service being built as part of DynamoDB→PostgreSQL migration.

## Eliminated
<!-- APPEND only - prevents re-investigating -->

- hypothesis: Wrong APP_TABLE_NAME env var pointing to non-existent table
  evidence: workers/.env has APP_TABLE_NAME="cost-optimization-scheduler-app-table" (same as example), but USE_PG_SCHEDULES=true means DynamoDB is never supposed to be used for schedules in this env
  timestamp: 2026-04-05T00:01:00Z

- hypothesis: GSI3 index missing from the DynamoDB table
  evidence: Irrelevant — root cause is that the DynamoDB path is called at all when USE_PG_SCHEDULES=true
  timestamp: 2026-04-05T00:01:00Z

## Evidence
<!-- APPEND only - facts discovered -->

- timestamp: 2026-04-05T00:01:00Z
  checked: workers/.env
  found: USE_PG_SCHEDULES="true" — PostgreSQL is the source of truth for schedules in this environment
  implication: DynamoDB table/GSI3 is not expected to exist or be populated

- timestamp: 2026-04-05T00:01:00Z
  checked: scheduler-service.ts runFullScan (lines 77-166)
  found: Full scan correctly branches on USE_PG_SCHEDULES — uses getSchedulesPg when true, fetchActiveSchedulesDynamo when false
  implication: The pattern for gating exists; partial scan just missed it

- timestamp: 2026-04-05T00:01:00Z
  checked: scheduler-service.ts runPartialScan (line 227)
  found: fetchScheduleById called unconditionally — no USE_PG_SCHEDULES gate
  implication: Always hits DynamoDB regardless of feature flag; throws ResourceNotFoundException when table/GSI3 absent

- timestamp: 2026-04-05T00:01:00Z
  checked: pg-service.ts
  found: getScheduleById function did not exist — only getSchedules (all active for a tenant)
  implication: The PG equivalent needed to be added before the gate could be wired up

- timestamp: 2026-04-05T00:01:00Z
  checked: tsc --noEmit after fix
  found: 2 pre-existing errors in custom-scanners.ts and discovery/index.ts — unrelated to this fix; scheduler files compile clean
  implication: Fix is type-safe

## Resolution
<!-- OVERWRITE as understanding evolves -->

root_cause: runPartialScan in scheduler-service.ts called fetchScheduleById (DynamoDB) unconditionally, with no USE_PG_SCHEDULES guard. workers/.env sets USE_PG_SCHEDULES=true, so the DynamoDB table/GSI3 is not present in this environment, causing ResourceNotFoundException on every partial scan job.

fix: |
  1. Added getScheduleById(scheduleId, tenantId) to pg-service.ts — queries schedules table by tenantId + scheduleId with multi-tenant safety
  2. Imported getScheduleById as getScheduleByIdPg in scheduler-service.ts
  3. Gated the lookup in runPartialScan: USE_PG_SCHEDULES ? getScheduleByIdPg(...) : fetchScheduleById(...)

verification: tsc --noEmit passes for scheduler files; pattern mirrors the existing USE_PG_SCHEDULES gate in runFullScan
files_changed:
  - workers/src/jobs/scheduler/services/pg-service.ts
  - workers/src/jobs/scheduler/services/scheduler-service.ts
