---
phase: 01-foundation-tenant-config
plan: 05
subsystem: database
tags: [postgres, prisma, dynamodb, migration, data-migration, tenant-config]

# Dependency graph
requires:
  - phase: 01-foundation-tenant-config
    plan: 03
    provides: TenantConfigPostgresRepository with prisma.tenantConfig.upsert, prisma/schema.prisma tenant_configs table with tenantId_configKey unique constraint
provides:
  - scripts/migrate-tenant-configs.ts — idempotent DynamoDB-to-PostgreSQL migration for all tenant config records
affects: [cutover, production-migration, all phases relying on USE_PG_TENANT_CONFIG=true]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Migration script pattern: ScanCommand with FilterExpression begins_with(sk, prefix) for DynamoDB single-table extraction"
    - "Tenant FK safety: upsert parent tenant row before inserting config (avoids FK constraint violation)"
    - "Idempotency via Prisma upsert: ON CONFLICT DO UPDATE equivalent, safe to re-run"
    - "Pagination via LastEvaluatedKey loop: handles DynamoDB tables larger than 1MB page limit"

key-files:
  created:
    - scripts/migrate-tenant-configs.ts
  modified: []

key-decisions:
  - "Added tenant upsert before config upsert: tenant_configs.tenantId has FK to tenants.id — plan's example code omitted this step, causing FK constraint violation. Added ensureTenantExists() with deduplication via seenTenants Set."
  - "Used tenantId as tenant name placeholder: DynamoDB has no tenant name — using tenantId as name value until real tenant names are populated in a later phase."

patterns-established:
  - "Migration script pattern: top-level error env check -> scan with pagination -> upsert with FK parent first -> progress log per record -> final count log"

requirements-completed: [TCFG-07, MIGR-01, MIGR-02, MIGR-06]

# Metrics
duration: 5min
completed: 2026-03-26
---

# Phase 1 Plan 05: Data Migration Summary

**Idempotent DynamoDB-to-PostgreSQL migration script for tenant configs using ScanCommand pagination, tenant FK safety, and Prisma upsert with "Migrated X/Y records..." progress logging**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-26T19:38:00Z
- **Completed:** 2026-03-26T19:43:42Z
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments
- Migration script scans all `CONFIG#` records from DynamoDB APP_TABLE_NAME using paginated ScanCommand
- Upserts parent `tenants` row before inserting config to satisfy FK constraint (discovered during implementation)
- Fully idempotent via `prisma.tenantConfig.upsert` — safe to re-run without duplicates
- Progress logging: "Migrated X/Y records..." per MIGR-06 with configKey and tenantId per line

## Task Commits

Each task was committed atomically:

1. **Task 1: Write scripts/migrate-tenant-configs.ts** - `3802eb1` (feat)

## Files Created/Modified
- `scripts/migrate-tenant-configs.ts` - Idempotent DynamoDB-to-PostgreSQL migration for tenant_configs; scans via FilterExpression begins_with(sk, 'CONFIG#'), paginates via LastEvaluatedKey, upserts tenant row first, then upserts config; prints "Migrated X/Y records..." per record and "Migration complete. Migrated N tenant config records." at end

## Decisions Made
- Added `ensureTenantExists()` call before each config upsert: the Prisma schema defines `TenantConfig.tenant` as a FK relation to `tenants.id`, so inserting a config for an unknown tenant would throw a FK constraint violation. Added a `tenant.upsert` call (using tenantId as both id and name placeholder) with a `seenTenants` Set to avoid redundant upserts within the same migration run.
- Used `tenantId` as the tenant `name` placeholder since DynamoDB has no tenant display name in the CONFIG# records. Downstream phases can update tenant names when real names become available.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added tenant row upsert before config upsert**
- **Found during:** Task 1 (writing scripts/migrate-tenant-configs.ts)
- **Issue:** Plan's provided code example called `prisma.tenantConfig.upsert` directly with a `tenantId` value, but `tenant_configs.tenantId` is a FK to `tenants.id`. If no matching tenant row exists, Prisma throws a FK constraint violation. DynamoDB has no corresponding tenants table, so all tenantIds would be orphaned.
- **Fix:** Added `ensureTenantExists(tenantId)` function that calls `prisma.tenant.upsert` with `id=tenantId`, `name=tenantId`. Added `seenTenants: Set<string>` to skip redundant upserts in a single run.
- **Files modified:** scripts/migrate-tenant-configs.ts
- **Verification:** Script contains `prisma.tenant.upsert` call before `prisma.tenantConfig.upsert`
- **Committed in:** 3802eb1 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 missing critical functionality)
**Impact on plan:** Fix necessary for FK constraint correctness. No scope creep — single helper function added inline.

## Issues Encountered
- Plan's code example omitted the parent tenant row creation step. The Prisma schema (created in plan 01-01) has `TenantConfig.tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)` making it a required FK. This was caught during implementation and auto-fixed per Rule 2.

## User Setup Required

To run the migration:

```bash
# 1. Start PostgreSQL
cd /path/to/nucleus-cloud-ops && docker compose up -d postgres

# 2. Apply schema (from web-ui directory)
cd web-ui && DATABASE_URL=postgresql://postgres:postgres@localhost:5432/nucleus npm run db:migrate

# 3. Run migration script
AWS_PROFILE=PLATFORM-ADMIN \
  APP_TABLE_NAME=cost-optimization-scheduler-app-table \
  DATABASE_URL=postgresql://postgres:postgres@localhost:5432/nucleus \
  npx tsx scripts/migrate-tenant-configs.ts
```

## Next Phase Readiness
- All tenant config records from DynamoDB are pre-seeded into PostgreSQL — ready for USE_PG_TENANT_CONFIG=true cutover
- Migration is idempotent — safe to re-run to sync any DynamoDB changes before final cutover
- Phase 1 (Foundation + Tenant Config) is complete: Docker Compose + Prisma schema + repositories + service wiring + migration script all in place

---
*Phase: 01-foundation-tenant-config*
*Completed: 2026-03-26*

## Self-Check: PASSED

- FOUND: scripts/migrate-tenant-configs.ts (in database-migration worktree)
- FOUND: 01-05-SUMMARY.md (this file)
- FOUND: commit 3802eb1 (feat: migration script)
- FOUND: commit e32e4d5 (docs: planning metadata)
