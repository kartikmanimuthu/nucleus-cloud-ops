---
phase: 14-tenant-context-enforcement
plan: 03
subsystem: lambda
tags: [scheduler, discovery, tenant-isolation, postgresql, dynamodb, multi-tenancy]

requires:
  - phase: 14-01
    provides: Prisma tenant model, getTenantClient, tenant middleware
provides:
  - getActiveTenants() in scheduler pg-service for tenant iteration
  - Scheduler Lambda tenant-sequential processing (runFullScan iterates active tenants)
  - DEFAULT_TENANT_ID fully removed from scheduler Lambda
  - Discovery Lambda tenant_id sourced from account record (get_tenant_id_for_account)
  - Normalized S3 output includes tenantId field
affects: [14-04, scheduler-lambda, discovery-lambda, vector-processor]

tech-stack:
  added: []
  patterns:
    - "Scheduler iterates active tenants sequentially via getActiveTenants()"
    - "Discovery resolves tenant_id from DynamoDB account record at scan start"
    - "No DEFAULT_TENANT_ID fallback anywhere in Lambda code"

key-files:
  created: []
  modified:
    - lambda/scheduler/src/services/scheduler-service.ts
    - lambda/scheduler/src/services/pg-service.ts
    - lambda/scheduler/src/services/dynamodb-service.ts
    - lambda/scheduler/src/services/execution-history-service.ts
    - lambda/scheduler/package.json
    - lambda/discovery/src/data_processor.py
    - lambda/discovery/src/main.py

key-decisions:
  - "tenantId guard in processSchedule skips schedules without tenantId (returns 0/0/0) rather than throwing"
  - "Discovery Lambda skips entire account if tenant_id unresolvable (fail loudly, no silent default)"
  - "DynamoDB fallback path in runFullScan preserved for USE_PG_SCHEDULES=false (backward compat)"

patterns-established:
  - "Lambda tenant iteration: getActiveTenants() -> for-of loop -> per-tenant schedule/account fetch"
  - "Tenant resolution: account record lookup via get_tenant_id_for_account() before any writes"

requirements-completed: [ISOL-03, ISOL-04]

duration: 18min
completed: 2026-04-01
---

# Phase 14 Plan 03: Lambda Tenant Isolation Summary

**Scheduler Lambda iterates active tenants sequentially with DEFAULT_TENANT_ID fully removed; discovery Lambda sources tenant_id from account record for all writes**

## Performance

- **Duration:** ~18 min
- **Started:** 2026-04-01T09:05:00Z
- **Completed:** 2026-04-01T09:23:00Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments
- Scheduler Lambda runFullScan now iterates active tenants via getActiveTenants() (D-07/D-09), suspended tenants excluded by WHERE status='active'
- All DEFAULT_TENANT_ID constants and fallbacks removed from scheduler Lambda (dynamodb-service, pg-service, execution-history-service, scheduler-service)
- Discovery Lambda resolves tenant_id from DynamoDB account record at scan start; skips accounts with unresolvable tenant_id
- Normalized S3 output and mark_missing_resources both parameterized with tenant_id

## Task Commits

1. **Task 1: Scheduler Lambda tenant iteration + DEFAULT_TENANT_ID removal** - `02ae4ef` (feat)
2. **Task 2: Discovery Lambda tenant_id tagging** - `d3abefd` (feat)

## Files Created/Modified
- `lambda/scheduler/src/services/pg-service.ts` - Added getActiveTenants(), already had no DEFAULT_TENANT_ID
- `lambda/scheduler/src/services/scheduler-service.ts` - Rewrote runFullScan with tenant iteration, removed wrapper functions, added tenantId guard in processSchedule, validated event.tenantId in runPartialScan
- `lambda/scheduler/src/services/dynamodb-service.ts` - Confirmed no DEFAULT_TENANT_ID (already clean from prior work)
- `lambda/scheduler/src/services/execution-history-service.ts` - Changed 4 functions from DEFAULT_TENANT_ID default to required tenantId: string parameter
- `lambda/scheduler/package.json` - Added --external:pg to esbuild build command
- `lambda/discovery/src/data_processor.py` - Added get_tenant_id_for_account(), removed 'default' fallbacks, added tenantId to normalized output, parameterized mark_missing_resources
- `lambda/discovery/src/main.py` - Extract tenantId from account records, resolve via lookup if missing, pass tenant_id through scan loop

## Decisions Made
- tenantId guard in processSchedule returns {0,0,0} instead of throwing — graceful skip for legacy data
- Discovery Lambda skips entire account if tenant_id unresolvable — fail loudly rather than silently writing to wrong tenant
- DynamoDB fallback path preserved in runFullScan when USE_PG_SCHEDULES=false for backward compatibility

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added pg to esbuild externals in scheduler Lambda**
- **Found during:** Task 1 (build verification)
- **Issue:** esbuild failed with "Could not resolve pg" — pg module was a dependency but not marked external
- **Fix:** Added `--external:pg` to the esbuild build command in package.json
- **Files modified:** lambda/scheduler/package.json
- **Verification:** `npm run build` succeeds (113.3kb bundle)
- **Committed in:** 02ae4ef (Task 1 commit)

**2. [Rule 1 - Bug] Fixed TypeScript type narrowing for schedule.tenantId**
- **Found during:** Task 1 (typecheck)
- **Issue:** Removing DEFAULT_TENANT_ID fallback exposed `string | undefined` type errors since Schedule.tenantId is optional
- **Fix:** Added tenantId guard at top of processSchedule, used narrowed `tenantId` local variable for all downstream calls
- **Files modified:** lambda/scheduler/src/services/scheduler-service.ts
- **Verification:** `npm run typecheck` passes for scheduler-service.ts (only pre-existing uuid type warnings remain)
- **Committed in:** 02ae4ef (Task 1 commit)

---

**Total deviations:** 2 auto-fixed (1 blocking, 1 bug)
**Impact on plan:** Both fixes necessary for build and type correctness. No scope creep.

## Issues Encountered
None beyond the auto-fixed deviations above.

## User Setup Required
None - no external service configuration required.

## Known Stubs
None - all functions are fully wired with real data sources.

## Next Phase Readiness
- Lambda tenant isolation complete, ready for Plan 04 (E2E verification)
- Scheduler Lambda builds cleanly and iterates tenants
- Discovery Lambda resolves tenant_id from account records

---
*Phase: 14-tenant-context-enforcement*
*Completed: 2026-04-01*

## Self-Check: PASSED
- SUMMARY.md: FOUND
- Commit 02ae4ef (Task 1): FOUND
- Commit d3abefd (Task 2): FOUND
