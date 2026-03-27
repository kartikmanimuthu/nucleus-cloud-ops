---
phase: 02-accounts-rbac
plan: 05
subsystem: testing
tags: [vitest, postgres, prisma, accounts, rbac, cross-tenant, isolation]

# Dependency graph
requires:
  - phase: 02-accounts-rbac
    plan: 02
    provides: AccountPostgresRepository implementation (postgres.ts)
provides:
  - web-ui/lib/db/repositories/account/postgres.test.ts (13 tests: base + cross-tenant isolation)
affects: [E2E verification, phase-3+ multi-tenant correctness audits]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Vitest mock pattern for Prisma: vi.mock('@/lib/db/pg-config') + vi.mocked(getPrismaClient).mockReturnValue({ account: { ... } })"
    - "Cross-tenant isolation test: verify findMany/findFirst where clause always includes correct tenantId"
    - "makeRow() helper function for DRY test fixture creation with sensible defaults + overrides"

key-files:
  created:
    - web-ui/lib/db/repositories/account/postgres.test.ts
  modified: []

key-decisions:
  - "postgres.test.ts created (not appended): plan 02-03 was skipped so the file did not exist; created it with both base tests (Plan 02-03 spec) and cross-tenant tests (Plan 02-05 spec)"
  - "getAccount cross-tenant test uses findFirst (not findUnique): actual postgres.ts implementation uses findFirst with { where: { tenantId, accountId } }, not findUnique with compound key — test corrected to match reality"

requirements-completed: [ACCT-09, ACCT-10]

# Metrics
duration: 8min
completed: 2026-03-27
---

# Phase 2 Plan 05: Accounts PostgreSQL Repository Tests + Cross-Tenant Isolation Summary

**13 Vitest unit tests for AccountPostgresRepository covering query scoping, pagination, ILIKE search, and 3 cross-tenant isolation tests confirming tenantId is always enforced in WHERE clauses**

## Performance

- **Duration:** 8 min
- **Started:** 2026-03-27T15:50:00Z
- **Completed:** 2026-03-27T15:58:00Z
- **Tasks:** 1 (+ checkpoint reached)
- **Files created:** 1

## Accomplishments

- Created `web-ui/lib/db/repositories/account/postgres.test.ts` with 13 passing tests covering all key repository behaviors
- Base tests (10): `getAccounts` with no filters (tenantId scoping), with `searchTerm` (OR clause with ILIKE), with `statusFilter=active/inactive/all`, pagination via skip/take; `getAccount` null/found/tenantId-in-where; `createAccount` calls create and returns UIAccount
- Cross-tenant isolation (3): `getAccounts for tenant-A never returns tenant-B records`, `getAccounts WHERE clause does not include a different tenantId`, `getAccount for tenant-A returns null for tenant-B record`
- All 13 tests pass via `vitest run`

## Task Commits

Each task was committed atomically:

1. **Task 1: Cross-tenant isolation unit test in AccountPostgresRepository** - `2850426` (test)

## Files Created

- `web-ui/lib/db/repositories/account/postgres.test.ts` — 13 Vitest unit tests for AccountPostgresRepository; includes both base functionality tests and the 3 cross-tenant isolation tests required by Plan 02-05

## Decisions Made

- `postgres.test.ts` was created as a new file (not appended), because Plan 02-03 (service wiring + initial test files) was skipped — the file did not exist. The base tests from Plan 02-03's spec were included alongside the cross-tenant isolation tests from Plan 02-05's spec.
- The cross-tenant isolation test for `getAccount` was adapted to use `findFirst` (matching the actual implementation) instead of `findUnique` with `tenantId_accountId` compound key (which was the plan template) — the actual `postgres.ts` uses `findFirst`, so the test was corrected to match reality.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Created postgres.test.ts from scratch (Plan 02-03 dependency not executed)**
- **Found during:** Task 1 (pre-task check of existing test file)
- **Issue:** Plan 02-05 specifies "append to EXISTING postgres.test.ts" but Plan 02-03 (which was supposed to create the file) was never executed. The file did not exist.
- **Fix:** Created the full `postgres.test.ts` with both the base tests specified in Plan 02-03's behavior spec AND the cross-tenant isolation tests from Plan 02-05. This satisfies both plans' acceptance criteria.
- **Files modified:** `web-ui/lib/db/repositories/account/postgres.test.ts` (created)
- **Verification:** `vitest run` — 13/13 tests pass
- **Committed in:** `2850426` (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking — missing prerequisite file)
**Impact on plan:** Auto-fix was necessary to unblock execution. The created file satisfies Plan 02-05 acceptance criteria exactly. No scope creep.

## Issues Encountered

- Plan 02-03 (service wiring + repository test files for all 4 implementations) was skipped. Only `account/postgres.test.ts` was created in this plan. The other 3 test files (`account/dynamo.test.ts`, `rbac/dynamo.test.ts`, `rbac/postgres.test.ts`) and the service wiring changes are still pending from Plan 02-03.
- The service layer (`account-service.ts`, `role-service.ts`) still uses direct DynamoDB persistence — `getAccountRepository()` and `getRbacRepository()` factory functions were not added to `repository-factory.ts`. This means `USE_PG_ACCOUNTS=true` does not yet route to PostgreSQL.

## Known Stubs

None in the created test file — all tests are fully wired to mock the Prisma client and verify real behavior.

## Next Phase Readiness

- Cross-tenant isolation confirmed at repository level via unit tests
- **Blocker for full E2E verification:** Plan 02-03 (service wiring) was not executed. The `account-service.ts` still calls DynamoDB directly. `USE_PG_ACCOUNTS=true` will not route to the PostgreSQL repository until Plan 02-03 is executed.
- Checkpoint human verification step still pending (see checkpoint task in 02-05-PLAN.md)

## Self-Check: PASSED

- FOUND: web-ui/lib/db/repositories/account/postgres.test.ts
- FOUND: commit 2850426 (test: AccountPostgresRepository unit tests + cross-tenant isolation)
- Tests: 13/13 passing via `vitest run lib/db/repositories/account/postgres.test.ts`
- `grep "cross-tenant isolation" postgres.test.ts` returns a match
- Cross-tenant block contains 3 tests as required by plan

---
*Phase: 02-accounts-rbac*
*Completed: 2026-03-27*
