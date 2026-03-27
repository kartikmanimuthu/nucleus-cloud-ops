---
phase: 02-accounts-rbac
plan: 04
subsystem: database
tags: [postgres, prisma, migration, accounts, rbac, dynamodb, idempotent]

# Dependency graph
requires:
  - phase: 02-accounts-rbac
    plan: 02
    provides: IAccountRepository and IRbacRepository implementations, Prisma account and userTenantRole accessors
provides:
  - scripts/migrate-accounts.ts (DynamoDB GSI1 TYPE#ACCOUNT to PostgreSQL accounts table, idempotent)
  - scripts/migrate-rbac.ts (DynamoDB UsersTeamsTable EntityType=UserTenantRole to PostgreSQL user_tenant_roles, idempotent)
  - @aws-sdk/client-dynamodb and @aws-sdk/lib-dynamodb added to root package.json for migration scripts
  - tsx added to root devDependencies for running migration scripts via npx tsx
affects: [02-05, production data migration, USE_PG_ACCOUNTS cutover enablement]

# Tech tracking
tech-stack:
  added:
    - "@aws-sdk/client-dynamodb ^3.821.0 in root package.json (for migration scripts)"
    - "@aws-sdk/lib-dynamodb ^3.821.0 in root package.json (for migration scripts)"
    - "tsx ^4.19.2 in root devDependencies (for running migration scripts)"
  patterns:
    - "GSI1 QueryCommand with KeyConditionExpression gsi1pk=TYPE#ACCOUNT for paginated account scan"
    - "ScanCommand with FilterExpression EntityType=UserTenantRole for full UsersTeamsTable scan"
    - "Prisma upsert with compound unique key (tenantId_accountId / userId_tenantId) for idempotency"
    - "Role validation guard before upsert: VALID_ROLES array checked, invalid roles skipped with warning"
    - "finally block prisma.$disconnect() pattern matches migrate-tenant-configs.ts exactly"

key-files:
  created:
    - scripts/migrate-accounts.ts
    - scripts/migrate-rbac.ts
  modified:
    - package.json (added AWS SDK DynamoDB packages + tsx devDependency)
    - package-lock.json (updated lockfile)

key-decisions:
  - "Root package.json extended with @aws-sdk/client-dynamodb and @aws-sdk/lib-dynamodb: scripts run from project root via npx tsx, these packages were only in web-ui/package.json previously"
  - "tsx added to root devDependencies: migration scripts use shebang #!/usr/bin/env npx tsx per existing migrate-tenant-configs.ts pattern"
  - "migrate-rbac.ts uses ScanCommand (not QueryCommand): UsersTeamsTable has no GSI — full scan with EntityType filter is the only option"
  - "VALID_ROLES guard in migrate-rbac.ts validates against CHECK constraint values before upsert: prevents invalid data from reaching PostgreSQL and producing constraint violations"

requirements-completed: [ACCT-08]

# Metrics
duration: 4min
completed: 2026-03-27
---

# Phase 2 Plan 04: Account Data Migration Script (DynamoDB to PostgreSQL) Summary

**Idempotent data migration scripts for accounts (GSI1 query) and RBAC (full scan + role validation) from DynamoDB to PostgreSQL using the same Prisma upsert pattern as migrate-tenant-configs.ts**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-27T10:15:54Z
- **Completed:** 2026-03-27T10:19:54Z
- **Tasks:** 2
- **Files created:** 2 (migrate-accounts.ts, migrate-rbac.ts)
- **Files modified:** 2 (package.json, package-lock.json)

## Accomplishments

- `scripts/migrate-accounts.ts`: queries DynamoDB NucleusAppTable GSI1 with `gsi1pk=TYPE#ACCOUNT`, paginates with `LastEvaluatedKey`, upserts each record to PostgreSQL accounts table via `prisma.account.upsert` with `tenantId_accountId` compound unique key
- `scripts/migrate-rbac.ts`: scans DynamoDB UsersTeamsTable with `FilterExpression: EntityType = :entityType`, validates role values against `VALID_ROLES` array before upsert, upserts to PostgreSQL user_tenant_roles via `prisma.userTenantRole.upsert` with `userId_tenantId` compound key
- Both scripts follow the exact same structure as `scripts/migrate-tenant-configs.ts`: env validation, DynamoDB client setup, PrismaClient with explicit DATABASE_URL, paginated scan/query, per-record progress logging, finally-block disconnect
- Both scripts exit 1 with clear ERROR message when required env vars are missing
- Added `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`, and `tsx` to root `package.json` so scripts compile and run from project root

## Task Commits

Each task was committed atomically:

1. **Task 1: migrate-accounts.ts — DynamoDB GSI1 TYPE#ACCOUNT to PostgreSQL accounts table** - `dbc12a1` (feat)
2. **Task 2: migrate-rbac.ts — DynamoDB UsersTeamsTable to PostgreSQL user_tenant_roles table** - `a6a145c` (feat)

## Files Created

- `scripts/migrate-accounts.ts` — DynamoDB GSI1 query (TYPE#ACCOUNT) → PostgreSQL accounts upsert; idempotent via tenantId_accountId compound key
- `scripts/migrate-rbac.ts` — DynamoDB UsersTeamsTable scan (EntityType=UserTenantRole) → PostgreSQL user_tenant_roles upsert; idempotent via userId_tenantId compound key; validates role against VALID_ROLES

## Decisions Made

- Root package.json extended with AWS SDK DynamoDB packages: migration scripts run from project root using `npx tsx scripts/migrate-*.ts` — these packages existed only in `web-ui/package.json` before this plan
- `tsx` added to root devDependencies: the shebang `#!/usr/bin/env npx tsx` in migration scripts requires `tsx` to be resolvable from the project root
- `migrate-rbac.ts` uses `ScanCommand` instead of `QueryCommand`: UsersTeamsTable has no GSI targeting EntityType — full scan with filter expression is the correct approach
- `VALID_ROLES` guard prevents PostgreSQL CHECK constraint violations: invalid role values from DynamoDB are skipped with a warning rather than causing hard migration failures

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical Functionality] Added AWS SDK DynamoDB packages to root package.json**
- **Found during:** Task 1 (TypeScript compilation check)
- **Issue:** `@aws-sdk/client-dynamodb` and `@aws-sdk/lib-dynamodb` were not in root `package.json` — only in `web-ui/package.json`. `migrate-tenant-configs.ts` (pre-existing) had the same gap. Without these, `npm run build` produced `Cannot find module '@aws-sdk/client-dynamodb'` errors.
- **Fix:** Added both packages to root `dependencies` at `^3.821.0`, matching the version used in `web-ui/package.json`. Also added `tsx ^4.19.2` to `devDependencies`.
- **Files modified:** `package.json`, `package-lock.json`
- **Commit:** `dbc12a1` (included in Task 1 commit)

## Known Stubs

None — both scripts are fully wired. No placeholder data or TODO items.

## Self-Check: PASSED

- FOUND: scripts/migrate-accounts.ts
- FOUND: scripts/migrate-rbac.ts
- FOUND: commit dbc12a1 (feat: account data migration script)
- FOUND: commit a6a145c (feat: RBAC data migration script)
- TypeScript compilation: `npm run build` exits 0 (no errors)
- ENV validation: `npx tsx scripts/migrate-accounts.ts` exits with `ERROR: APP_TABLE_NAME...` (correct)
- ENV validation: `npx tsx scripts/migrate-rbac.ts` exits with `ERROR: DATABASE_URL...` (correct)

---
*Phase: 02-accounts-rbac*
*Completed: 2026-03-27*
