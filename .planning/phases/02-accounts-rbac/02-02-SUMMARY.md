---
phase: 02-accounts-rbac
plan: 02
subsystem: database
tags: [postgres, prisma, repository-pattern, accounts, rbac, dynamo, interface]

# Dependency graph
requires:
  - phase: 02-accounts-rbac
    plan: 01
    provides: Account and UserTenantRole Prisma models, PostgreSQL migration, PrismaClient accessors
provides:
  - IAccountRepository interface (AccountFilters, AccountPage, 5-method contract)
  - AccountDynamoRepository (GSI1 query + client-side filter, preserves existing DynamoDB path)
  - AccountPostgresRepository (server-side WHERE/ILIKE/LIMIT/OFFSET, Prisma account model)
  - IRbacRepository interface (4-method contract)
  - RbacDynamoRepository (DYNAMODB_USERS_TEAMS_TABLE, shared DynamoDB client singleton)
  - RbacPostgresRepository (Prisma userTenantRole model, upsert for assignUserRole)
affects: [02-03, 02-04, 02-05, account-service.ts delegation, role-service.ts delegation]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Repository interface + dual implementation pattern for zero-downtime migration feature flags"
    - "AccountPostgresRepository.getAccounts builds WHERE clause server-side instead of fetch-all-then-filter"
    - "RbacPostgresRepository uses Prisma compound key userId_tenantId for upsert/findUnique"
    - "transformToUIAccount in DynamoDB repo handles both snake_case and camelCase DynamoDB field names"
    - "mapToUserTenantRole preserves DynamoDB PK/SK/EntityType shape for interface compatibility"

key-files:
  created:
    - web-ui/lib/db/repositories/account/interface.ts
    - web-ui/lib/db/repositories/account/dynamo.ts
    - web-ui/lib/db/repositories/account/postgres.ts
    - web-ui/lib/db/repositories/rbac/interface.ts
    - web-ui/lib/db/repositories/rbac/dynamo.ts
    - web-ui/lib/db/repositories/rbac/postgres.ts
  modified:
    - .planning/STATE.md (resolved merge conflict)

key-decisions:
  - "AccountDynamoRepository preserves GSI1 + client-side filter pattern: maintains identical DynamoDB path behaviour, no risk of changing query semantics"
  - "AccountPostgresRepository.updateAccount uses tenantId_accountId compound key for Prisma update: matches @@unique([tenantId, accountId]) from schema"
  - "RbacDynamoRepository uses getDynamoDBDocumentClient() singleton: consistent with rest of repository layer (role-service.ts created its own client)"

requirements-completed: [ACCT-03, ACCT-04]

# Metrics
duration: 7min
completed: 2026-03-27
---

# Phase 2 Plan 02: Account and RBAC Repository Implementations Summary

**Account and RBAC repository layer: interface contracts + DynamoDB (legacy path) + PostgreSQL (server-side queries) implementations for zero-downtime migration cutover**

## Performance

- **Duration:** 7 min
- **Started:** 2026-03-27T10:02:05Z
- **Completed:** 2026-03-27T10:09:14Z
- **Tasks:** 2
- **Files created:** 6 (3 account repos, 3 rbac repos)

## Accomplishments

- IAccountRepository interface with AccountFilters (searchTerm, statusFilter, connectionFilter, page, limit, tenantId), AccountPage (accounts, totalCount), and 5-method contract
- AccountDynamoRepository: GSI1 TYPE#ACCOUNT query with client-side filtering — exact preservation of account-service.ts behaviour
- AccountPostgresRepository: `getAccounts` builds Prisma `where` clause with OR for ILIKE search, active/connectionStatus filters, and `Promise.all([count, findMany])` for efficient pagination
- IRbacRepository interface with getUserTenantRole, getUserAllRoles, assignUserRole, getTenantUsers
- RbacDynamoRepository: extracts DYNAMODB_USERS_TEAMS_TABLE logic from role-service.ts; uses shared `getDynamoDBDocumentClient()` singleton
- RbacPostgresRepository: Prisma userTenantRole model with upsert for assignUserRole; `userId_tenantId` compound key; `mapToUserTenantRole` preserves DynamoDB PK/SK/EntityType shape

## Task Commits

Each task was committed atomically:

1. **Task 1: IAccountRepository interface + DynamoDB and PostgreSQL implementations** - `ef9e44a` (feat)
2. **Task 2: IRbacRepository interface + DynamoDB and PostgreSQL implementations** - `5eac674` (feat)

## Files Created

- `web-ui/lib/db/repositories/account/interface.ts` — IAccountRepository, AccountFilters, AccountPage exports
- `web-ui/lib/db/repositories/account/dynamo.ts` — AccountDynamoRepository (GSI1 + client-side filter)
- `web-ui/lib/db/repositories/account/postgres.ts` — AccountPostgresRepository (server-side WHERE/ILIKE)
- `web-ui/lib/db/repositories/rbac/interface.ts` — IRbacRepository with 4-method contract
- `web-ui/lib/db/repositories/rbac/dynamo.ts` — RbacDynamoRepository (DYNAMODB_USERS_TEAMS_TABLE)
- `web-ui/lib/db/repositories/rbac/postgres.ts` — RbacPostgresRepository (Prisma userTenantRole)

## Decisions Made

- AccountDynamoRepository preserves GSI1 + client-side filter: maintains exact existing DynamoDB path behaviour, preventing any accidental query semantic changes
- AccountPostgresRepository.updateAccount uses `tenantId_accountId` Prisma compound key: matches @@unique([tenantId, accountId]) schema constraint
- RbacDynamoRepository switches from per-instance DynamoDBClient to shared `getDynamoDBDocumentClient()` singleton: aligns with repository layer convention established in phase 01

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Resolved STATE.md merge conflict before commit**
- **Found during:** Task 1 commit
- **Issue:** `.planning/STATE.md` had a git merge conflict (`<<<<<<< Updated upstream` / `>>>>>>> Stashed changes`) preventing commit
- **Fix:** Resolved conflict by keeping the more recent "Updated upstream" content (stopped_at: 02-01-PLAN.md, progress showing 7 completed plans) and merging relevant fields from both sides
- **Files modified:** .planning/STATE.md
- **Commit:** ef9e44a (included in Task 1 commit)

## Known Stubs

- `resourceCount: 0`, `schedulesCount: 0`, `monthlySavings: 0` in both `transformToUIAccount` methods (DynamoDB and PostgreSQL repos). These are placeholder values that existed in the original account-service.ts. They will be computed by a future plan when schedule/resource counts are joined from their respective tables.

## Self-Check: PASSED

- FOUND: web-ui/lib/db/repositories/account/interface.ts
- FOUND: web-ui/lib/db/repositories/account/dynamo.ts
- FOUND: web-ui/lib/db/repositories/account/postgres.ts
- FOUND: web-ui/lib/db/repositories/rbac/interface.ts
- FOUND: web-ui/lib/db/repositories/rbac/dynamo.ts
- FOUND: web-ui/lib/db/repositories/rbac/postgres.ts
- FOUND: commit ef9e44a (feat: IAccountRepository + DynamoDB/PostgreSQL implementations)
- FOUND: commit 5eac674 (feat: IRbacRepository + DynamoDB/PostgreSQL implementations)
- TypeScript compilation: no errors in repositories/account or repositories/rbac

---
*Phase: 02-accounts-rbac*
*Completed: 2026-03-27*
