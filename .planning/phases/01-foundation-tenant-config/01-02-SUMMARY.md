---
phase: 01-foundation-tenant-config
plan: 02
subsystem: database
tags: [postgres, prisma, repository-pattern, feature-flags, singleton]

# Dependency graph
requires:
  - phase: 01-foundation-tenant-config
    plan: 01
    provides: Prisma 5 schema, @prisma/client installation, USE_PG_* env vars in .env.local.example
provides:
  - getPrismaClient() Prisma singleton with dev hot-reload safety (web-ui/lib/db/pg-config.ts)
  - disconnectPrisma() for Lambda cleanup and test teardown
  - getTenantConfigRepository() factory reading USE_PG_TENANT_CONFIG feature flag
  - isUsingPostgres(entityFlag) helper for testing and logging
affects: [01-03, 01-04, 01-05, all subsequent phases using repository pattern]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Prisma singleton: globalThis.__prismaClient in dev, module-level var in production"
    - "Repository factory: dynamic require() defers Prisma import to avoid errors when DATABASE_URL absent"
    - "Feature flag: USE_PG_TENANT_CONFIG=true routes to PostgreSQL, false routes to DynamoDB"
    - "ITenantConfigRepository typed as any placeholder — Plan 03 replaces with real interface import"

key-files:
  created:
    - web-ui/lib/db/pg-config.ts
    - web-ui/lib/db/repository-factory.ts
  modified: []

key-decisions:
  - "Prisma singleton uses globalThis for dev to survive Next.js hot reloads, matching aws-config.ts pattern"
  - "Dynamic require() in factory prevents build failure when DATABASE_URL not set in DynamoDB-only deployments"
  - "ITenantConfigRepository placeholder type documented with explicit Plan 03 replacement comment"

patterns-established:
  - "Singleton pattern: getPrismaClient() mirrors getDynamoDBDocumentClient() from aws-config.ts"
  - "Factory pattern: getTenantConfigRepository() reads env var and returns appropriate implementation"
  - "Feature flag: process.env.USE_PG_TENANT_CONFIG === 'true' is the canonical flag check pattern"

requirements-completed: [FOUND-03, FOUND-04]

# Metrics
duration: 8min
completed: 2026-03-26
---

# Phase 1 Plan 02: PostgreSQL Singleton + Repository Factory Summary

**Prisma 5 singleton (getPrismaClient) with Next.js hot-reload safety and feature-flag-driven repository factory (getTenantConfigRepository) for zero-downtime DynamoDB-to-PostgreSQL cutover**

## Performance

- **Duration:** 8 min
- **Started:** 2026-03-26T19:28:17Z
- **Completed:** 2026-03-26T19:36:00Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- Prisma singleton mirrors aws-config.ts pattern: globalThis guard for dev hot reloads, module-level var for production ECS
- disconnectPrisma() exported for Lambda handler cleanup and test teardown
- getTenantConfigRepository() reads USE_PG_TENANT_CONFIG; uses dynamic require() to avoid Prisma import errors when DATABASE_URL is absent
- isUsingPostgres(entityFlag) helper enables consistent flag checking across repositories and tests

## Task Commits

Each task was committed atomically:

1. **Task 1: PostgreSQL connection singleton (pg-config.ts)** - `10ffdb7` (feat)
2. **Task 2: Repository factory (repository-factory.ts)** - `c8cfe95` (feat)

**Plan metadata:** (docs commit below)

## Files Created/Modified
- `web-ui/lib/db/pg-config.ts` - Prisma 5 singleton with getPrismaClient() and disconnectPrisma()
- `web-ui/lib/db/repository-factory.ts` - Feature-flag-driven factory returning DynamoDB or PostgreSQL repo

## Decisions Made
- Used dynamic `require()` instead of static `import` for repository implementations to prevent build failures when DATABASE_URL is not configured. This is critical for DynamoDB-only deployment scenarios.
- The `ITenantConfigRepository` type is explicitly typed as `any` with a prominent comment pointing to Plan 03 for replacement. This avoids creating a circular dependency before the interface exists.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Resolved merge conflict in STATE.md**
- **Found during:** Task 1 commit
- **Issue:** STATE.md had unresolved git merge conflict markers (<<<<<<< Updated upstream / >>>>>>> Stashed changes) between Plan 01 completion state and an earlier stash. Git refused to commit with unmerged files.
- **Fix:** Resolved conflict by keeping the Plan 01 completion state (completed_plans: 1, percent: 20, status: executing)
- **Files modified:** .planning/STATE.md
- **Verification:** git add .planning/STATE.md succeeded without error
- **Committed in:** 10ffdb7 (Task 1 commit, included as part of staging)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Auto-fix necessary to allow commit. STATE.md conflict was stale stash data — resolved to correct Plan 01 completion state. No scope creep.

## Issues Encountered
- npm dependencies not installed in the database-migration superset worktree. Ran `npm install` and `npm run db:generate` to install Prisma 5 and generate the TypeScript client before creating pg-config.ts.
- Full TypeScript project compilation (`tsc --noEmit`) ran out of memory (4GB heap limit) on this machine — pre-existing issue unrelated to this plan. Verified pg-config.ts syntax with targeted check instead; only pre-existing MDX type errors were found.

## Known Stubs
None — pg-config.ts and repository-factory.ts are infrastructure files. pg-config.ts returns a real Prisma client. The factory's dynamic require() targets implementation files created in Plan 03 (not stubs).

## Next Phase Readiness
- Plan 03 can import getPrismaClient() from '@/lib/db/pg-config' and use it in TenantConfigPostgresRepository
- Plan 03 replaces `type ITenantConfigRepository = any` in repository-factory.ts with the real interface import
- Feature flag USE_PG_TENANT_CONFIG=true routes to PostgreSQL; false routes to DynamoDB — zero-downtime cutover ready

---
*Phase: 01-foundation-tenant-config*
*Completed: 2026-03-26*
