# Testing Strategy

**Analysis Date:** 2026-04-08

## Test Frameworks

**web-ui (Vitest):**
- Runner: Vitest ^4.0.18
- Config: `web-ui/vitest.config.ts`
- Environment: `node` (not jsdom — no DOM globals by default)
- Globals: `true` (no imports needed for `describe`, `it`, `expect`)
- Path alias `@/` resolved to `web-ui/`
- Coverage: `@vitest/coverage-v8` ^4.0.18 installed but no threshold configured

**Workers (Vitest):**
- Runner: Vitest ^2.1.8
- Config: `workers/vitest.config.ts`
- Environment: `node`, globals: `true`
- Run: `cd workers && npm run test`

**Lambda scheduler (Vitest):**
- Runner: Vitest (separate instance)
- Config: `lambda/scheduler/package.json` → `vitest run`
- Test file: `lambda/scheduler/src/services/dynamodb-service.test.ts`

**Root (Jest):**
- Runner: Jest ^29.7.0 + ts-jest ^29.2.5
- Config: root `package.json` → `jest` (no jest.config.* file found — uses defaults)
- No active test files found at root level

**E2E (Playwright):**
- Runner: @playwright/test ^1.58.2
- Config: `playwright.config.ts` (root)
- Browser: Chromium only (`Desktop Chrome` device)
- Parallel: disabled (`fullyParallel: false`, `workers: 1`) — tests share state
- Retries: 2 on CI, 0 locally
- Tracing: `retain-on-failure`; screenshots: `only-on-failure`
- Web server: auto-starts `cd web-ui && npm run dev` on port 3000

**Property-Based (fast-check):**
- Library: fast-check ^4.5.3
- Integrated into Vitest test suites
- Convention: `numRuns: 100–200` per property

## Run Commands

```bash
# web-ui unit + property tests (Vitest)
cd web-ui && npm run test          # Run once (vitest run)
cd web-ui && npm run test:watch    # Watch mode (vitest)

# Workers tests (Vitest)
cd workers && npm run test         # Run once (vitest run)
cd workers && npm run test:watch   # Watch mode (vitest)

# Root tests (Jest)
npm test                           # Run at repo root

# Lambda scheduler tests (Vitest)
cd lambda/scheduler && npm run test

# E2E tests (Playwright) — requires dev server running or auto-starts it
npx playwright test                              # All E2E tests
npx playwright test tests/e2e/accounts.spec.ts   # Specific spec
npx playwright test --headed                     # Headed mode
npx playwright test --ui                         # Interactive UI mode
npx playwright show-report                       # View last HTML report

# Coverage (web-ui)
cd web-ui && npx vitest run --coverage
```

## Test File Organization

**Location patterns:**
- Repository unit tests: colocated at `web-ui/lib/db/repositories/<entity>/postgres.test.ts`
- Service unit tests: colocated at `web-ui/lib/<service>.test.ts`
- API route tests: colocated at `web-ui/app/api/<domain>/<domain>-api.test.ts`
- RBAC tests: colocated at `web-ui/lib/rbac/permissions.test.ts`, `web-ui/lib/rbac/custom-role-service.test.ts`
- Agent tests: `web-ui/tests/agent/` and `web-ui/tests/agent-ops/`
- Tenant isolation tests: `web-ui/tests/tenant-isolation/` and `web-ui/tests/isolation/`
- Property-based tests: `web-ui/tests/agent-ops/*.property.test.ts`
- E2E specs: `tests/e2e/*.spec.ts`
- Workers tests: colocated at `workers/src/boss.test.ts`

**Naming:**
- Unit tests: `<module>.test.ts`
- Property tests: `<module>.property.test.ts`
- E2E specs: `<feature>.spec.ts`
- E2E auth setup: `auth.setup.ts`

## Unit Tests

**Repository Tests (12 files):**

Every Postgres repository has a colocated test file. Pattern:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockedFunction } from 'vitest';

// Mock the tenant client
vi.mock('@/lib/db/pg-config', () => ({
    getTenantClient: vi.fn(),
}));

import { getTenantClient } from '@/lib/db/pg-config';
import { AccountPostgresRepository } from './postgres';

// Factory for test data
const makeRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'cuid-1',
    accountId: 'acc-1',
    name: 'Test Account',
    // ... defaults
    ...overrides,
});

describe('AccountPostgresRepository', () => {
    let mockPrisma: { account: { findMany: MockedFunction<any>; /* ... */ } };

    beforeEach(() => {
        mockPrisma = {
            account: {
                findMany: vi.fn(),
                count: vi.fn(),
                // ... mock all used methods
            },
        };
        vi.mocked(getTenantClient).mockReturnValue(mockPrisma as any);
    });

    it('queries only by tenantId when no filters provided', async () => {
        mockPrisma.account.count.mockResolvedValue(1);
        mockPrisma.account.findMany.mockResolvedValue([makeRow()]);

        const repo = new AccountPostgresRepository();
        const result = await repo.getAccounts({ tenantId: 'org-default' });

        expect(mockPrisma.account.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ tenantId: 'org-default' }),
            })
        );
    });
});
```

Repository test files:
- `web-ui/lib/db/repositories/account/postgres.test.ts`
- `web-ui/lib/db/repositories/agent-ops-event/postgres.test.ts`
- `web-ui/lib/db/repositories/agent-ops-run/postgres.test.ts`
- `web-ui/lib/db/repositories/audit-log/postgres.test.ts`
- `web-ui/lib/db/repositories/data-source/postgres.test.ts`
- `web-ui/lib/db/repositories/inventory/postgres.test.ts`
- `web-ui/lib/db/repositories/knowledge-base/postgres.test.ts`
- `web-ui/lib/db/repositories/rbac/postgres.test.ts`
- `web-ui/lib/db/repositories/schedule/postgres.test.ts`
- `web-ui/lib/db/repositories/schedule-execution/postgres.test.ts`
- `web-ui/lib/db/repositories/scheduled-task/postgres.test.ts`
- `web-ui/lib/db/repositories/tenant-config/postgres.test.ts`

**Service Tests:**
- `web-ui/lib/account-service.test.ts` — mocks repository factory, verifies delegation + audit logging
- `web-ui/lib/schedule-service.test.ts` — mocks repository factory + AuditService
- `web-ui/lib/schedule-execution-service.test.ts` — mocks repository factory

**API Route Tests:**
- `web-ui/app/api/accounts/accounts-api.test.ts` — mocks NextResponse, next-auth, authorize, AccountService; tests GET/POST/PUT/DELETE
- `web-ui/app/api/schedules/schedules-api.test.ts` — same pattern for schedules routes

**RBAC Tests:**
- `web-ui/lib/rbac/permissions.test.ts` — exhaustive matrix of role × action × module permissions
- `web-ui/lib/rbac/custom-role-service.test.ts` — mocks Prisma client, tests CRUD for custom roles

**Agent Tests:**
- `web-ui/lib/agent/persistence.test.ts` — verifies PostgreSQL vs DynamoDB backend selection
- `web-ui/tests/agent-ops/agent-shared.test.ts` — sanitizeMessagesForBedrock, getRecentMessages
- `web-ui/tests/agent-ops/slack-validator.test.ts` — HMAC-SHA256 signature verification
- `web-ui/tests/agent-ops/slack-notifier.test.ts` — Slack notification sending
- `web-ui/tests/agent-ops/slack-trigger.test.ts` — Slack slash command trigger
- `web-ui/tests/agent/file-upload.test.ts` — file upload logic

**Workers Tests:**
- `workers/src/boss.test.ts` — verifies pg-boss instance creation with DATABASE_URL

## Mocking Patterns

**Prisma/Database Mocking:**
```typescript
vi.mock('@/lib/db/pg-config', () => ({
    getTenantClient: vi.fn(),
}));

// In beforeEach:
const mockPrisma = {
    account: {
        findMany: vi.fn(),
        count: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        deleteMany: vi.fn(),
    },
};
vi.mocked(getTenantClient).mockReturnValue(mockPrisma as any);
```

**Service Mocking (for API route tests):**
```typescript
vi.mock('@/lib/account-service', () => ({
    AccountService: {
        getAccounts: vi.fn(),
        createAccount: vi.fn(),
    },
}));
```

**Auth Mocking:**
```typescript
vi.mock('@/lib/auth-session', () => ({
    getSessionTenantId: vi.fn(),
    getAuthSession: vi.fn(),
    getSessionUserId: vi.fn(),
}));
vi.mock('@/lib/rbac/authorize', () => ({
    authorize: vi.fn().mockResolvedValue(null), // null = authorized
}));
vi.mock('next-auth', () => ({ getServerSession: vi.fn().mockResolvedValue(null) }));
```

**AWS SDK Mocking:**
```typescript
const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));
vi.mock('@aws-sdk/lib-dynamodb', async (importOriginal) => {
    const actual = await importOriginal() as any;
    return {
        ...actual,
        DynamoDBDocumentClient: {
            from: vi.fn().mockReturnValue({ send: mockSend }),
        },
    };
});
```

**Module Reset (for env-dependent modules):**
```typescript
async function loadValidatorWithSecret(secret: string) {
    vi.resetModules();
    process.env.SLACK_SIGNING_SECRET = secret;
    const mod = await import('../../lib/agent-ops/slack-validator');
    return mod.verifySlackSignature;
}
```

## Tenant Isolation Tests

**API-level isolation** (`web-ui/tests/tenant-isolation/`):
- 6 test files covering accounts, agent-ops, audit-logs, inventory, knowledge-base, schedules
- Pattern: mock `getSessionTenantId` to return tenant-A, verify service is called with tenant-A only, verify tenant-B is never queried
- Files:
  - `web-ui/tests/tenant-isolation/accounts.test.ts`
  - `web-ui/tests/tenant-isolation/agent-ops.test.ts`
  - `web-ui/tests/tenant-isolation/audit-logs.test.ts`
  - `web-ui/tests/tenant-isolation/inventory.test.ts`
  - `web-ui/tests/tenant-isolation/knowledge-base.test.ts`
  - `web-ui/tests/tenant-isolation/schedules.test.ts`

**Database-level isolation** (`web-ui/tests/isolation/two-tenant-isolation.test.ts`):
- Integration test against real PostgreSQL (requires running database)
- Seeds data for two tenants, verifies `getTenantClient(TENANT_A)` cannot see TENANT_B records
- Tests read isolation, write isolation (auto-sets tenantId), and cross-tenant delete prevention
- Covers: Account, Schedule, AuditLog, ChatMessage, AgentMemory, CustomRole
- Uses `beforeAll` for seed, `afterAll` for cleanup via unscoped Prisma client

## Property-Based Tests

**fast-check usage:**

```typescript
import * as fc from 'fast-check';
import { describe, it } from 'vitest';

describe('property description', () => {
    it('invariant description', () => {
        fc.assert(
            fc.property(fc.uuid(), fc.integer({ min: 10, max: 150 }), (id, n) => {
                // return boolean — true = invariant holds
                return someInvariant(id, n);
            }),
            { numRuns: 200 }
        );
    });
});
```

**Existing property tests:**
- `web-ui/tests/agent-ops/agent-ops-service.property.test.ts` — Event SK uniqueness: generating N SKs in rapid succession produces N unique values; SK format matches `EVENT#<ISO-timestamp>#<9-digit-nanos>`
- `web-ui/tests/agent-ops/slack-validator.property.test.ts` — HMAC-SHA256 correctness: signature computed with same secret returns true; different secret returns false. Uses `fc.asyncProperty` with `numRuns: 100`

## E2E Tests

**Auth Setup:**
- `tests/e2e/auth.setup.ts` — mints a NextAuth JWT session token via `next-auth/jwt` encode
- Stores session cookie in `tests/e2e/.auth/session.json`
- All non-setup tests depend on `setup` project and inherit the session cookie
- Test user: `kartikmanimuthu@smcindiaonline.com`, groups: `['SuperAdmins']`

**E2E Test Files:**
- `tests/e2e/accounts.spec.ts` — AWS Accounts module (page load, filters, grid/table views, CRUD)
- `tests/e2e/accounts-pg.spec.ts` — PostgreSQL-specific accounts tests
- `tests/e2e/schedules.spec.ts` — Schedules module
- `tests/e2e/schedules-pg.spec.ts` — PostgreSQL-specific schedules tests
- `tests/e2e/agent-chat.spec.ts` — Agent chat flows
- `tests/e2e/agent-ops.spec.ts` — Agent ops module
- `tests/e2e/knowledge-base.spec.ts` — Knowledge base module
- `tests/e2e/navigation.spec.ts` — App navigation flows
- `tests/e2e/marketing.spec.ts` — Marketing/landing page
- `tests/e2e/docs.spec.ts` — Documentation pages

**E2E Test Structure:**
```typescript
import { test, expect, Page } from '@playwright/test';

async function gotoPage(page: Page) {
    const res = await page.goto('/app/route', { waitUntil: 'domcontentloaded', timeout: 60000 });
    expect(res?.status()).not.toBe(404);
    expect(page.url()).not.toContain('/login');
}

test.describe('Feature — Section', () => {
    test.beforeEach(async ({ page }) => { await gotoPage(page); });

    test('specific assertion', async ({ page }) => {
        await expect(page.getByRole('heading', { name: 'Title' })).toBeVisible({ timeout: 15000 });
    });
});
```

**Locator Preference (E2E):**
1. `page.getByRole()` — semantic, preferred
2. `page.getByText()` — for visible text content
3. `page.getByLabel()` — for form inputs
4. `page.getByTestId()` — when `data-testid` is added to components

**Never use `waitForTimeout`** — use `expect(...).toBeVisible({ timeout: N })` or `waitForLoadState` instead.

## Coverage

**Requirements:** No coverage thresholds configured in any vitest or jest config.

**View Coverage:**
```bash
cd web-ui && npx vitest run --coverage
```

**Enforcement:** `@vitest/coverage-v8` is installed but not run in CI by default.

## Test Coverage Gaps

**React Component Tests:**
- No component-level tests (no jsdom setup, no React Testing Library)
- All component testing is done via E2E only
- Risk: component prop changes and edge cases are not caught until E2E

**Lambda Functions (except scheduler):**
- `lambda/discovery/` (Python) — no test files
- `lambda/vector_processor/` — no test files
- `lambda/kb_sync_processor/` — no test files
- Only `lambda/scheduler/src/services/dynamodb-service.test.ts` exists for lambdas

**Workers Job Handlers:**
- Only `workers/src/boss.test.ts` exists (tests pg-boss creation)
- No tests for actual job handlers in `workers/src/jobs/scheduler/`, `workers/src/jobs/kb-sync/`, `workers/src/jobs/discovery/`
- Risk: job processing logic changes go unvalidated

**Infrastructure Tests:**
- No Pulumi infrastructure tests
- Risk: infrastructure changes deploy unvalidated

**Coverage Enforcement:**
- No coverage thresholds configured anywhere
- No CI pipeline detected that runs tests automatically

---

*Testing analysis: 2026-04-08*
