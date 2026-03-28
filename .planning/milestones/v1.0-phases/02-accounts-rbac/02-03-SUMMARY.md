---
phase: 02-accounts-rbac
plan: 03
subsystem: database
tags: [postgres, dynamo, repository-pattern, service-layer, accounts, rbac, vitest]

# Dependency graph
requires:
  - phase: 02-accounts-rbac
    plan: 02
    provides: IAccountRepository + AccountDynamoRepository + AccountPostgresRepository + IRbacRepository + RbacDynamoRepository + RbacPostgresRepository
provides:
  - getAccountRepository() factory (USE_PG_ACCOUNTS controls DynamoDB vs PostgreSQL)
  - getRbacRepository() factory (USE_PG_RBAC controls DynamoDB vs PostgreSQL)
  - account-service.ts thin delegation layer (no inline DynamoDB persistence)
  - role-service.ts thin delegation layer (no inline DynamoDB client)
  - 36 Vitest unit tests covering all 4 repository implementations
affects: [02-04, 02-05, all API routes using AccountService, all auth middleware using getUserTenantRole]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Factory functions use dynamic require() to defer Prisma import — avoids DATABASE_URL errors in DynamoDB-only deployments"
    - "AccountService delegates all 5 CRUD methods to getAccountRepository(); preserves scanResources, validateCredentials, validateAccount, toggleAccountStatus untouched"
    - "role-service.ts function signatures unchanged — callers (authorize.ts, auth routes) require zero modification"
    - "DynamoDB mock pattern: vi.mock('@/lib/aws-config') + mockSend.mock.calls[0][0].input to inspect commands"
    - "Prisma mock pattern: vi.mock('@/lib/db/pg-config') + per-model mock object with per-method vi.fn()"

key-files:
  created:
    - web-ui/lib/db/repositories/account/dynamo.test.ts
    - web-ui/lib/db/repositories/account/postgres.test.ts
    - web-ui/lib/db/repositories/rbac/dynamo.test.ts
    - web-ui/lib/db/repositories/rbac/postgres.test.ts
  modified:
    - web-ui/lib/db/repository-factory.ts
    - web-ui/lib/account-service.ts
    - web-ui/lib/rbac/role-service.ts

key-decisions:
  - "account-service.ts retains AuditService.logUserAction calls in the service layer — audit is a cross-cutting concern, not a repository concern"
  - "role-service.ts catch blocks swallow errors and return null/[] (preserving original behavior) — repository layer throws, service catches"
  - "dynamic require() for repository classes — defers Prisma import until needed, prevents DATABASE_URL startup errors on DynamoDB-only deployments"

requirements-completed: [ACCT-05, ACCT-06, ACCT-07]

# Metrics
duration: 12min
completed: 2026-03-27
---

# Phase 2 Plan 03: Service Layer Delegation + Repository Tests Summary

**Service layer wired to repository pattern: account-service.ts and role-service.ts now delegate all persistence through getAccountRepository()/getRbacRepository() factory functions; 36 Vitest tests verify all 4 repository implementations**

## Performance

- **Duration:** 12 min
- **Started:** 2026-03-27T10:10:00Z
- **Completed:** 2026-03-27T10:22:08Z
- **Tasks:** 2
- **Files modified:** 3 (factory + 2 services)
- **Files created:** 4 (test files)

## Accomplishments

- Extended `repository-factory.ts` with `getAccountRepository()` (USE_PG_ACCOUNTS) and `getRbacRepository()` (USE_PG_RBAC) — both use dynamic `require()` to defer Prisma import
- Rewrote `account-service.ts`: removed all inline DynamoDB persistence (ScanCommand, PutCommand, DeleteCommand, UpdateCommand, QueryCommand, GetCommand, APP_TABLE_NAME); 5 CRUD methods now delegate to `getAccountRepository()`; scanResources, validateCredentials, validateAccount, toggleAccountStatus preserved intact
- Rewrote `role-service.ts`: removed DynamoDBClient, DynamoDBDocumentClient instantiation, TABLE_NAME constant; all 4 exported functions (same signatures) delegate to `getRbacRepository()`
- 36 Vitest unit tests across 4 files — all passing:
  - `AccountDynamoRepository` (9 tests): GSI1 pagination, JS-side statusFilter, getAccount null/found, createAccount PK/SK, deleteAccount keys
  - `AccountPostgresRepository` (7 tests): tenantId-only query, searchTerm OR+ILIKE, statusFilter active/inactive, totalCount, getAccount null/found, createAccount shape
  - `RbacDynamoRepository` (9 tests): getUserTenantRole PK/SK/return/null, getUserAllRoles begins_with prefix, assignUserRole EntityType, getTenantUsers EntityTypeIndex
  - `RbacPostgresRepository` (9 tests): getUserTenantRole compound key findUnique/null/return, getUserAllRoles PK-SK-EntityType map, assignUserRole upsert shape, getTenantUsers where/map

## Task Commits

Each task was committed atomically:

1. **Task 1: Add factory functions and rewrite service delegation layers** - `c4cd652` (feat)
2. **Task 2: Vitest unit tests for all 4 repository implementations** - `f90dd17` (test)

## Files Modified

- `web-ui/lib/db/repository-factory.ts` — added getAccountRepository() and getRbacRepository() factory functions
- `web-ui/lib/account-service.ts` — rewritten: removed 501 lines of inline DynamoDB persistence, now delegates to getAccountRepository()
- `web-ui/lib/rbac/role-service.ts` — rewritten: removed raw DynamoDB client, all 4 functions delegate to getRbacRepository()

## Files Created

- `web-ui/lib/db/repositories/account/dynamo.test.ts` — 9 tests for AccountDynamoRepository
- `web-ui/lib/db/repositories/account/postgres.test.ts` — 7 tests for AccountPostgresRepository
- `web-ui/lib/db/repositories/rbac/dynamo.test.ts` — 9 tests for RbacDynamoRepository
- `web-ui/lib/db/repositories/rbac/postgres.test.ts` — 9 tests for RbacPostgresRepository

## Decisions Made

- `account-service.ts` retains `AuditService.logUserAction` calls in service layer — audit is a cross-cutting concern (observability + compliance), not a storage concern; repositories remain pure persistence
- `role-service.ts` catch blocks swallow errors (return null/[]) preserving original caller-visible behavior — the repository layer throws, the service catches and returns safe defaults
- `dynamic require()` for all repository classes — defers Prisma client import until the factory is called at runtime, preventing `DATABASE_URL` startup errors when running in DynamoDB-only mode

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

- `resourceCount: 0`, `schedulesCount: 0`, `monthlySavings: 0` in both `transformToUIAccount` methods inherited from Plan 02. These flow to UI rendering. They are tracked in Plan 02's SUMMARY and will be resolved when schedule/resource counts are joined from their respective tables in a later phase.

## Self-Check: PASSED

- FOUND: web-ui/lib/db/repository-factory.ts (getAccountRepository + getRbacRepository)
- FOUND: web-ui/lib/account-service.ts (delegates to getAccountRepository)
- FOUND: web-ui/lib/rbac/role-service.ts (delegates to getRbacRepository)
- FOUND: web-ui/lib/db/repositories/account/dynamo.test.ts
- FOUND: web-ui/lib/db/repositories/account/postgres.test.ts
- FOUND: web-ui/lib/db/repositories/rbac/dynamo.test.ts
- FOUND: web-ui/lib/db/repositories/rbac/postgres.test.ts
- FOUND: commit c4cd652 (feat: wire account and RBAC repositories into service layer)
- FOUND: commit f90dd17 (test: Vitest unit tests for all 4 repository implementations)
- TypeScript compilation: 0 errors (npx tsc --noEmit --skipLibCheck)
- Test results: 36/36 new tests PASS; pre-existing failures in file-upload.test.ts and agent-executor.test.ts unchanged

---
*Phase: 02-accounts-rbac*
*Completed: 2026-03-27*
