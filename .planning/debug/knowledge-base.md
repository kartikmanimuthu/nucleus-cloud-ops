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
