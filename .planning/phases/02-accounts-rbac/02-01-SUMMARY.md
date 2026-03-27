---
phase: 02-accounts-rbac
plan: 01
subsystem: database
tags: [postgres, prisma, schema, migration, accounts, rbac, user-tenant-roles]

# Dependency graph
requires:
  - phase: 01-foundation-tenant-config
    provides: Prisma 5 schema with Tenant and TenantConfig models, PostgreSQL Docker Compose, migration tooling
provides:
  - Account Prisma model with tenantId+accountId unique constraint and tenantId+active index
  - UserTenantRole Prisma model with userId+tenantId unique constraint
  - PostgreSQL migration 20260327095408_add_accounts_and_rbac applying both tables
  - CHECK constraint enforcing role IN (SuperAdmin, TenantAdmin, TenantOperator, TenantViewer)
  - Regenerated PrismaClient with .account and .userTenantRole accessors
affects: [02-02, 02-03, 02-04, 02-05, all account and RBAC repository implementations]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "No FK relations for Account/UserTenantRole to Tenant — plain string tenantId for zero-downtime migration"
    - "CHECK constraints for enum-like fields not supported natively by Prisma — add post-generation by patching migration SQL + ALTER TABLE"
    - "postgres CREATEDB privilege required for prisma migrate dev shadow database"

key-files:
  created:
    - prisma/migrations/20260327095408_add_accounts_and_rbac/migration.sql
    - prisma/migrations/20260327063922_init/migration.sql
    - prisma/migrations/migration_lock.toml
  modified:
    - prisma/schema.prisma

key-decisions:
  - "No FK relations between Account/UserTenantRole and Tenant: plain tenantId string avoids requiring all tenants in tenants table before migration, enabling zero-downtime cutover"
  - "Role CHECK constraint added via ALTER TABLE after migration generation (not in Prisma schema): Prisma does not natively emit CHECK constraints, migration SQL patched manually"
  - "Existing itsm_postgres container on port 5432 reused: created nucleus user+database within it rather than requiring a separate container"

patterns-established:
  - "Account model: @@unique([tenantId, accountId]) enables per-tenant uniqueness; @@index([tenantId, active]) for active account list queries"
  - "UserTenantRole model: @@unique([userId, tenantId]) one role per user per tenant; @@index([tenantId]) for tenant role listing"
  - "Migration patching workflow: generate with prisma migrate dev, patch SQL, apply constraint via ALTER TABLE for dev environment"

requirements-completed: [ACCT-01, ACCT-02]

# Metrics
duration: 15min
completed: 2026-03-27
---

# Phase 2 Plan 01: Accounts + RBAC Schema Summary

**Prisma Account and UserTenantRole models with PostgreSQL migration, indexes, and CHECK constraint enforcing role values**

## Performance

- **Duration:** 15 min
- **Started:** 2026-03-27T09:50:15Z
- **Completed:** 2026-03-27T10:05:00Z
- **Tasks:** 2
- **Files modified:** 4 (schema.prisma, 2 migration SQL files, migration_lock.toml)

## Accomplishments
- Account model with 14 fields mapping AccountMetadata interface, @@unique([tenantId, accountId]), @@index([tenantId, active])
- UserTenantRole model with 7 fields mapping RBAC UserTenantRole interface, @@unique([userId, tenantId])
- Migration 20260327095408_add_accounts_and_rbac creates both tables and all indexes
- CHECK constraint on user_tenant_roles.role enforcing valid TenantRole values
- PrismaClient regenerated: prisma.account and prisma.userTenantRole accessors available

## Task Commits

Each task was committed atomically:

1. **Task 1: Add Account and UserTenantRole models to Prisma schema** - `30f58da` (feat)
2. **Task 2: Generate and apply migration for accounts and user_tenant_roles tables** - `f894902` (feat)

## Files Created/Modified
- `prisma/schema.prisma` - Added Account and UserTenantRole models (43 lines added)
- `prisma/migrations/20260327095408_add_accounts_and_rbac/migration.sql` - accounts + user_tenant_roles DDL with CHECK constraint
- `prisma/migrations/20260327063922_init/migration.sql` - Restored initial tenants + tenant_configs migration from git history
- `prisma/migrations/migration_lock.toml` - Prisma migration lock file

## Decisions Made
- No FK relation from Account/UserTenantRole to Tenant: enables zero-downtime migration since DynamoDB tenant IDs don't necessarily exist in the tenants table yet
- Role CHECK constraint applied via ALTER TABLE after migration generation: Prisma 5 doesn't support CHECK constraints natively in schema; migration SQL was patched post-generation
- Used existing port-5432 itsm_postgres container: created nucleus user+database within it instead of starting nucleus-postgres (port conflict)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Restored initial migration files from git history**
- **Found during:** Task 2 (Generate and apply migration)
- **Issue:** prisma/migrations/ directory did not exist on working tree — the initial migration for tenants/tenant_configs was only in git history (committed to the database-migration branch in Phase 1 but not present in worktree files)
- **Fix:** Extracted migration.sql and migration_lock.toml from git object `497a73d` using `git show`, created migration directory, applied initial migration first to establish baseline
- **Files modified:** prisma/migrations/20260327063922_init/migration.sql, prisma/migrations/migration_lock.toml
- **Verification:** `prisma migrate deploy` applied initial migration successfully, then new migration generated on top
- **Committed in:** f894902 (Task 2 commit)

**2. [Rule 3 - Blocking] Granted CREATEDB privilege to nucleus PostgreSQL role**
- **Found during:** Task 2 (Generate and apply migration)
- **Issue:** `prisma migrate dev` requires CREATEDB to create shadow database; nucleus user was created without CREATEDB privilege
- **Fix:** `ALTER ROLE nucleus CREATEDB` via itsm postgres superuser
- **Files modified:** None (database-only change)
- **Verification:** Migration generated successfully after grant
- **Committed in:** N/A (database admin operation)

**3. [Rule 3 - Blocking] Used existing itsm_postgres container instead of nucleus-postgres**
- **Found during:** Task 2 (Docker Compose startup)
- **Issue:** Port 5432 already allocated by itsm_postgres container; nucleus-postgres container could not start
- **Fix:** Created nucleus user and database within itsm_postgres container; DATABASE_URL uses same host/port with nucleus credentials
- **Files modified:** None
- **Verification:** `prisma migrate status` shows "Database schema is up to date"
- **Committed in:** N/A (environment setup)

---

**Total deviations:** 3 auto-fixed (all Rule 3 blocking — environment and migration state issues)
**Impact on plan:** All fixes necessary for environment compatibility. No schema or functionality scope creep.

## Issues Encountered
- Initial migration files from Phase 1 not present in working tree (only in git history) — required extraction and restoration before new migration could be generated

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Account model ready for repository implementation (Plan 02-02)
- UserTenantRole model ready for RBAC repository (Plan 02-02)
- PrismaClient types available: `prisma.account`, `prisma.userTenantRole`
- Database tables exist with all constraints and indexes

## Self-Check: PASSED

- FOUND: prisma/schema.prisma (Account and UserTenantRole models present)
- FOUND: prisma/migrations/20260327095408_add_accounts_and_rbac/migration.sql (with CHECK constraint)
- FOUND: .planning/phases/02-accounts-rbac/02-01-SUMMARY.md
- FOUND: commit 30f58da (feat: Account and UserTenantRole Prisma models)
- FOUND: commit f894902 (feat: generate and apply migration)
- FOUND: commit 143cb7f (docs: planning artifacts)

---
*Phase: 02-accounts-rbac*
*Completed: 2026-03-27*
