# GSD Debug Knowledge Base

Resolved debug sessions. Used by `gsd-debugger` to surface known-pattern hypotheses at the start of new investigations.

---

## discovery-pagination-cap — MAX_PAGES=20 constant silently truncates discovery scan results
- **Date:** 2026-04-05
- **Error patterns:** pagination, MAX_PAGES, discovery, scanner, truncated, missing resources, silently
- **Root cause:** MAX_PAGES=20 constant in workers/src/jobs/discovery/services/scanner.ts was added as a Lambda timeout safeguard. Discovery job was later moved to ECS where no timeout concern exists, making the cap an artificial truncation that silently omits resources in large AWS accounts.
- **Fix:** Removed MAX_PAGES constant; changed do-while loop condition from `nextToken && pages < MAX_PAGES` to `nextToken`; added console.log after loop reporting total pages scanned per service/region when pages > 1.
- **Files changed:** workers/src/jobs/discovery/services/scanner.ts
---

## gsi3-resource-not-found — runPartialScan calls DynamoDB unconditionally, ignoring USE_PG_SCHEDULES flag
- **Date:** 2026-04-05
- **Error patterns:** ResourceNotFoundException, GSI3, fetchScheduleById, runPartialScan, DynamoDB, USE_PG_SCHEDULES, partial scan
- **Root cause:** runPartialScan in scheduler-service.ts called fetchScheduleById (DynamoDB) unconditionally with no USE_PG_SCHEDULES guard. With USE_PG_SCHEDULES=true the DynamoDB table/GSI3 does not exist, causing ResourceNotFoundException on every partial scan job.
- **Fix:** Added getScheduleById to pg-service.ts; imported it in scheduler-service.ts; gated the lookup with USE_PG_SCHEDULES ? getScheduleByIdPg(...) : fetchScheduleById(...), mirroring the existing pattern in runFullScan.
- **Files changed:** workers/src/jobs/scheduler/services/pg-service.ts, workers/src/jobs/scheduler/services/scheduler-service.ts
---

## schedule-update-p2025 — PUT/DELETE route passes schedule name instead of UUID to postgres repository
- **Date:** 2026-04-06
- **Error patterns:** P2025, Record to update not found, scheduleId, tenantId_scheduleId, updateSchedule, STX_Data_Archive_Schedule, 500
- **Root cause:** PUT and DELETE route handlers in app/api/schedules/[scheduleId]/route.ts passed the raw URL param (schedule name) directly to ScheduleService.updateSchedule/deleteSchedule. The postgres repository's updateSchedule uses a tenantId_scheduleId composite unique key expecting a sched-* UUID — a name string never matches, causing Prisma P2025. The pre-flight getSchedule call already resolved the name to the full record (including the UUID as .id) but the route discarded it.
- **Fix:** In PUT handler, moved body parsing after getSchedule and used existing.id (UUID) instead of scheduleId (name) for both updateData.id and the updateSchedule call. Applied same fix to DELETE handler. Updated two tests that needed getSchedule mocked before the error path could be reached.
- **Files changed:** web-ui/app/api/schedules/[scheduleId]/route.ts, web-ui/app/api/schedules/schedules-api.test.ts
---

## kb-sync-datasource-not-populating — dual-write bug causes vectorCount/vectorKeys to never save
- **Date:** 2026-04-06
- **Error patterns:** data_sources, vectorCount, vectorKeys, not populated, kb-sync, DynamoDB, USE_PG_KB, lastSyncError, error detail
- **Root cause:** updateDS/updateKBVectorCount in vector-store.ts always called DynamoDB even when USE_PG_KB=true. DDB write threw (no local table), aborting the success path after PG write — vectorCount/vectorKeys never saved. Additionally, missing lastErrorMessage/lastErrorDetail columns meant error stack traces were silently dropped.
- **Fix:** Changed dual-write to use else branch (PG xor DDB). Added migration + Prisma schema for lastErrorMessage/lastErrorDetail. Worker now captures full stack trace into lastErrorDetail. Repository, types, and UI updated to surface the new columns.
- **Files changed:** workers/src/jobs/kb-sync/lib/vector-store.ts, workers/src/jobs/kb-sync/index.ts, prisma/schema.prisma, prisma/migrations/20260406_add_datasource_error_columns/migration.sql, web-ui/lib/db/repositories/data-source/postgres.ts, web-ui/lib/knowledge-base/types.ts, web-ui/app/app/knowledge-base/[kbId]/page.tsx
---
