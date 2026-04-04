---
phase: 20-knowledge-base-channels-isolation
plan: 01
subsystem: database, api
tags: [prisma, tenant-isolation, knowledge-base, data-source, rbac]

requires:
  - phase: 19-inventory-agent-ops-isolation
    provides: getTenantClient pattern and pre-flight 403 ownership check pattern

provides:
  - Tenant-scoped KnowledgeBasePostgresRepository (getTenantClient on all 7 methods)
  - Tenant-scoped DataSourcePostgresRepository (getTenantClient on all 5 methods)
  - Pre-flight 403 ownership checks on all [kbId] API routes
  - Cross-tenant vector search fix in query route (tenant-scoped KB filter when no kbId)

affects: [knowledge-base, data-source, query, upload, sync]

tech-stack:
  added: []
  patterns:
    - "getTenantClient(tenantId) in repository layer — same pattern as accounts/schedules/inventory"
    - "Pre-flight KB ownership check before data source mutations (parent KB check provides child isolation)"
    - "tenantId always extracted unconditionally in query route for cross-tenant vector filter"

key-files:
  created: []
  modified:
    - web-ui/lib/db/repositories/knowledge-base/postgres.ts
    - web-ui/lib/db/repositories/data-source/postgres.ts
    - web-ui/app/api/knowledge-base/[kbId]/route.ts
    - web-ui/app/api/knowledge-base/[kbId]/sources/route.ts
    - web-ui/app/api/knowledge-base/[kbId]/sources/[dsId]/route.ts
    - web-ui/app/api/knowledge-base/[kbId]/sources/[dsId]/sync/route.ts
    - web-ui/app/api/knowledge-base/[kbId]/upload/route.ts
    - web-ui/app/api/knowledge-base/query/route.ts

key-decisions:
  - "getTenantClient(tenantId) in KB and DataSource repos — consistent with Phase 18/19 pattern"
  - "Data source service methods called without tenantId — isolation via parent KB ownership pre-flight"
  - "Query route: tenantId extracted unconditionally; no-kbId path filters to tenant's KB IDs to prevent cross-tenant vector leakage"
  - "Upload pre-flight before S3 upload — avoids storing files for KBs the user doesn't own"

patterns-established:
  - "Parent-child isolation: verify parent ownership (KB), then call child methods (DataSource) without tenantId"
  - "Cross-tenant vector filter: listKnowledgeBases(tenantId) → Set of IDs → filter rawVectors"

requirements-completed: [KB-01, KB-02, KB-03, KB-04, KB-05]

duration: 15min
completed: 2026-04-03
---

# Phase 20 Plan 01: Knowledge Base & Data Source Isolation Summary

**getTenantClient migration for KB/DataSource repos + pre-flight 403 ownership checks on all 8 KB API routes including cross-tenant vector search fix**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-04-03T20:06:00Z
- **Completed:** 2026-04-03T20:21:44Z
- **Tasks:** 2
- **Files modified:** 8

## Accomplishments
- Replaced `getPrismaClient()` with `getTenantClient(tenantId)` in all 7 KB repo methods and all 5 DataSource repo methods
- Added pre-flight 403 ownership checks to all 5 `[kbId]` API routes (PUT/DELETE on kbId, GET/POST on sources, GET/PUT/DELETE on dsId, POST sync, POST upload)
- Fixed cross-tenant vector leakage in query route — when no `knowledgeBaseId` provided, results now scoped to tenant's KBs only

## Task Commits

1. **Task 1: Migrate KB and DataSource repositories to getTenantClient** - `2cc990d` (feat)
2. **Task 2: Add pre-flight 403 ownership checks to all KB API routes** - `9bf9cd5` (feat)

## Files Created/Modified
- `web-ui/lib/db/repositories/knowledge-base/postgres.ts` - All 7 methods use getTenantClient(tenantId)
- `web-ui/lib/db/repositories/data-source/postgres.ts` - All 5 methods use getTenantClient(tenantId)
- `web-ui/app/api/knowledge-base/[kbId]/route.ts` - PUT returns 403; DELETE adds pre-flight
- `web-ui/app/api/knowledge-base/[kbId]/sources/route.ts` - GET and POST add KB ownership pre-flight
- `web-ui/app/api/knowledge-base/[kbId]/sources/[dsId]/route.ts` - GET, PUT, DELETE add KB ownership pre-flight
- `web-ui/app/api/knowledge-base/[kbId]/sources/[dsId]/sync/route.ts` - POST adds pre-flight before SQS enqueue
- `web-ui/app/api/knowledge-base/[kbId]/upload/route.ts` - Pre-flight before S3 upload; tenantId moved early
- `web-ui/app/api/knowledge-base/query/route.ts` - tenantId unconditional; cross-tenant vector filter

## Decisions Made
- Data source service methods (`listDataSources`, `getDataSource`, etc.) called without tenantId — the parent KB ownership pre-flight provides sufficient isolation since data sources are children of a KB
- Query route cross-tenant fix: `listKnowledgeBases(tenantId)` builds a Set of allowed KB IDs, then filters rawVectors — prevents leakage when caller omits `knowledgeBaseId`

## Deviations from Plan

None — plan executed exactly as written. Duplicate `tenantId` declarations (from pre-existing late calls) were cleaned up inline as part of the planned edits.

## Issues Encountered
None.

## User Setup Required
None — no external service configuration required.

## Next Phase Readiness
- KB and DataSource isolation complete; ready for channels isolation (plan 20-02)
- All 5 KB requirements (KB-01 through KB-05) satisfied

---
*Phase: 20-knowledge-base-channels-isolation*
*Completed: 2026-04-03*
