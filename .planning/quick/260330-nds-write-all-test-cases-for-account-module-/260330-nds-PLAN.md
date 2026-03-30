# Quick Task 260330-nds: Account Module — Full Test Coverage
# Plan

**Created:** 2026-03-30
**Mode:** quick
**Description:** Write all test cases for account module - add, edit, delete, activate, search, filter, pagination - unit and e2e tests, execute and validate, report bugs

---

## Context

Existing tests already cover:
- `tests/e2e/accounts.spec.ts` (958 lines) — E2E: page load, filters, grid/table view, create form, edit form, delete dialog, refresh, pagination, filter apply flow
- `tests/e2e/accounts-pg.spec.ts` — E2E: PostgreSQL backend API contract + server-side filtering
- `web-ui/lib/db/repositories/account/postgres.test.ts` (277 lines) — Unit: getAccounts, getAccount, createAccount, cross-tenant isolation
- `web-ui/lib/db/repositories/account/dynamo.test.ts` (184 lines) — Unit: getAccounts, getAccount, createAccount, deleteAccount

**Gaps identified:**
1. No unit tests for `AccountService` (service layer — createAccount, updateAccount, deleteAccount, validateAccount, activate/deactivate)
2. No unit tests for API routes (GET/POST /api/accounts, GET/PUT/DELETE /api/accounts/[accountId])
3. Missing postgres.test.ts coverage: updateAccount, deleteAccount, connectionFilter
4. E2E gaps: activate/deactivate flow, pagination with API verification, search sends correct query param

---

## Tasks

### Task 1: Add missing unit tests to postgres.test.ts
**Files:** `web-ui/lib/db/repositories/account/postgres.test.ts`
**Action:** Append new describe blocks for:
- `updateAccount` — updates fields, scoped by tenantId_accountId composite key
- `deleteAccount` — calls deleteMany with correct tenantId+accountId
- `getAccounts` with connectionFilter — sets where.connectionStatus
- `getAccounts` default pagination — page=1, limit=10 defaults
**Verify:** `cd web-ui && npm run test -- --reporter=verbose 2>&1 | grep -E "(PASS|FAIL|✓|✗|account)" | head -40`
**Done:** All new tests pass

### Task 2: Write AccountService unit tests
**Files:** `web-ui/lib/account-service.test.ts` (new file)
**Action:** Create unit tests for AccountService using vi.mock for repository and AuditService:
- `getAccounts` — delegates to repository with correct filters
- `getAccount` — returns null when not found, returns account when found
- `createAccount` — calls repo.createAccount + AuditService.logUserAction
- `updateAccount` — calls repo.updateAccount + AuditService.logUserAction
- `deleteAccount` — calls repo.deleteAccount + AuditService.logUserAction
- `validateAccount` — throws when account not found, throws when no roleArn
**Verify:** `cd web-ui && npm run test -- --reporter=verbose 2>&1 | grep -E "(PASS|FAIL|✓|✗|AccountService)" | head -40`
**Done:** All AccountService tests pass

### Task 3: Write API route unit tests
**Files:** `web-ui/app/api/accounts/accounts-api.test.ts` (new file)
**Action:** Create unit tests for the accounts API routes using vi.mock for AccountService and authorize:
- GET /api/accounts — returns 200 with accounts, passes filters from query params
- GET /api/accounts — returns 403 when unauthorized
- POST /api/accounts — creates account, returns 200
- POST /api/accounts — returns 500 on service error
- GET /api/accounts/[accountId] — returns 200 with account data
- GET /api/accounts/[accountId] — returns 404 when not found
- PUT /api/accounts/[accountId] — updates account, returns 200
- DELETE /api/accounts/[accountId] — deletes account, returns 200
**Verify:** `cd web-ui && npm run test -- --reporter=verbose 2>&1 | grep -E "(PASS|FAIL|✓|✗|api)" | head -40`
**Done:** All API route tests pass

### Task 4: Run all unit tests and report results
**Files:** none (run only)
**Action:** Run full unit test suite and capture output
**Verify:** `cd web-ui && npm run test 2>&1 | tail -30`
**Done:** Test summary captured, bugs identified

### Task 5: Run E2E tests and report results
**Files:** none (run only)
**Action:** Run existing E2E account tests (requires dev server running)
**Verify:** `cd /Users/kartik/.superset/worktrees/nucleus-cloud-ops/database-migration && npx playwright test tests/e2e/accounts.spec.ts tests/e2e/accounts-pg.spec.ts --reporter=list 2>&1 | tail -50`
**Done:** E2E results captured, bugs identified

---

## must_haves
- AccountService unit tests cover all 6 methods
- postgres.test.ts gains updateAccount + deleteAccount + connectionFilter coverage
- API route tests cover GET/POST list + GET/PUT/DELETE single
- All new unit tests pass (vitest)
- Bug report produced from test run results
