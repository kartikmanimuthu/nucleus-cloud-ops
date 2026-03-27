---
phase: 01-foundation-tenant-config
plan: 01
subsystem: database
tags: [postgres, prisma, docker-compose, feature-flags, schema, migration]

# Dependency graph
requires: []
provides:
  - PostgreSQL 16 local dev environment via Docker Compose
  - Prisma 5 schema with Tenant and TenantConfig models at prisma/schema.prisma
  - db:start/stop/generate/migrate/studio npm scripts in web-ui
  - DATABASE_URL and USE_PG_* feature flag env vars in .env.local.example
affects: [01-02, 01-03, 01-04, 01-05, all subsequent phases using PostgreSQL]

# Tech tracking
tech-stack:
  added:
    - prisma@5.22.0 (schema migration tooling)
    - "@prisma/client@5.22.0 (TypeScript client generation)"
    - postgres:16-alpine (Docker Compose container)
  patterns:
    - "Feature flag per entity: USE_PG_<ENTITY>=false default, set true to route to PostgreSQL"
    - "Prisma schema at repo root prisma/ not web-ui/prisma/ (schema path: ../prisma/schema.prisma from web-ui)"

key-files:
  created:
    - docker-compose.yml
    - prisma/schema.prisma
  modified:
    - web-ui/package.json
    - web-ui/package-lock.json
    - web-ui/.env.local.example

key-decisions:
  - "Prisma 5 (not 7) chosen: Prisma 7 broke datasource url in schema files requiring prisma.config.ts — v5 matches plan expectations and avoids breaking change"
  - "Schema at repo root prisma/ not web-ui/prisma/ for shared access across future Lambda integrations"
  - "USE_PG_* flags default false so existing DynamoDB path stays active until explicitly enabled"

patterns-established:
  - "Prisma schema path: all commands use --schema=../prisma/schema.prisma when run from web-ui/"
  - "Docker Compose postgres container: nucleus-postgres on port 5432 with persistent volume postgres_data"

requirements-completed: [FOUND-01, FOUND-02, FOUND-05, FOUND-06, TCFG-01]

# Metrics
duration: 5min
completed: 2026-03-26
---

# Phase 1 Plan 01: Foundation Summary

**PostgreSQL 16 local dev via Docker Compose, Prisma 5 schema with tenants and tenant_configs models, and 6 USE_PG_* feature flags for zero-downtime cutover**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-26T19:18:17Z
- **Completed:** 2026-03-26T19:22:50Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- Docker Compose with postgres:16-alpine, healthcheck, persistent volume ready at repo root
- Prisma schema defines Tenant and TenantConfig with FK, @@unique([tenantId, configKey]), @@index([tenantId]), and data Json field
- 6 db:* npm scripts added to web-ui/package.json covering start/stop/migrate/generate/studio/deploy
- DATABASE_URL and all 6 USE_PG_* feature flags added to web-ui/.env.local.example

## Task Commits

Each task was committed atomically:

1. **Task 1: Docker Compose + Prisma install + npm scripts** - `5b1bb1a` (chore)
2. **Task 2: Prisma schema (tenants + tenant_configs) and .env.local.example update** - `c029d13` (feat)

## Files Created/Modified
- `docker-compose.yml` - PostgreSQL 16 service with healthcheck, volume, port 5432
- `prisma/schema.prisma` - Tenant and TenantConfig Prisma models with constraints
- `web-ui/package.json` - Added prisma@5, @prisma/client@5, and 6 db:* scripts
- `web-ui/package-lock.json` - Updated lockfile after npm install
- `web-ui/.env.local.example` - Appended DATABASE_URL and 6 USE_PG_* flags

## Decisions Made
- Used Prisma 5 instead of the installed Prisma 7 because Prisma 7 removed `url` from datasource in schema files (breaking change requiring prisma.config.ts). Downgraded to v5 to match plan expectations.
- Placed Prisma schema at repo root `prisma/` directory (not `web-ui/prisma/`) so it can be referenced by multiple consumers in future phases.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Downgraded Prisma from v7 to v5**
- **Found during:** Task 2 (Prisma schema validation)
- **Issue:** npm install prisma resolved to ^7.5.0. Prisma 7 removed `url = env("DATABASE_URL")` from datasource blocks in schema files — validation failed with P1012 error requiring migration to `prisma.config.ts`.
- **Fix:** Ran `npm install prisma@5 @prisma/client@5 --save` to pin to Prisma 5 which supports the schema format specified in the plan.
- **Files modified:** web-ui/package.json, web-ui/package-lock.json
- **Verification:** `DATABASE_URL=postgresql://... prisma validate --schema=../prisma/schema.prisma` exits 0
- **Committed in:** c029d13 (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Auto-fix necessary for schema format compatibility. No scope creep.

## Issues Encountered
- Prisma 7 breaking change: `prisma init --schema=../prisma/schema.prisma` flag not supported in v7. Worked around by creating prisma/ directory and schema.prisma manually, then downgrading to Prisma 5.

## User Setup Required
None - no external service configuration required. Run `cd web-ui && npm run db:start` to start PostgreSQL, then `npm run db:migrate` (requires DATABASE_URL in .env.local).

## Next Phase Readiness
- PostgreSQL foundation ready: Docker Compose starts a healthy postgres:16-alpine container on port 5432
- Prisma schema validated and correct for Phase 1 Plan 02 (TenantConfig repository implementation)
- Feature flags in place; existing DynamoDB code paths untouched
- Plans 02-05 can now build repository implementations on top of this schema

---
*Phase: 01-foundation-tenant-config*
*Completed: 2026-03-26*
