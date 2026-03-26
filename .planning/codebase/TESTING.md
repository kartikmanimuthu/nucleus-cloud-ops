# Testing Strategy

**Analysis Date:** 2026-03-26

## Test Frameworks

**web-ui (Vitest):**
- Runner: Vitest ^4.0.18
- Config: `web-ui/vitest.config.ts`
- Environment: `node` (not jsdom — no DOM globals by default)
- Globals: `true` (no imports needed for `describe`, `it`, `expect`)
- Path alias `@/` resolved to `web-ui/`
- Coverage: `@vitest/coverage-v8` installed but no threshold configured

**Lambda scheduler (Vitest):**
- Runner: Vitest (separate instance)
- Config: `lambda/scheduler/package.json` → `vitest run`
- Test file: `lambda/scheduler/src/services/dynamodb-service.test.ts`

**CDK stacks (Jest):**
- Runner: Jest ^29.7.0 + ts-jest
- Config: root `package.json` → `jest` (no jest.config.* found — uses package.json config or defaults)
- Test file: `test/cdk-2.test.ts` — currently all assertions are commented out (stub only)

**E2E (Playwright):**
- Runner: @playwright/test ^1.58.2
- Config: `playwright.config.ts` (root)
- Browser: Chromium only (`Desktop Chrome` device)
- Parallel: disabled (`fullyParallel: false`, `workers: 1`) — tests share state
- Retries: 2 on CI, 0 locally
- Tracing: `retain-on-failure`; screenshots: `only-on-failure`

## Test Types & Coverage

**Unit Tests (Vitest — web-ui):**
- Location: `web-ui/tests/`
- Subdirectories:
  - `web-ui/tests/agent/` — agent multimodal/file upload logic
  - `web-ui/tests/agent-ops/` — agent-ops service layer, Slack integration, models

**Property-Based Tests (fast-check):**
- `web-ui/tests/agent-ops/agent-ops-service.property.test.ts` — SK uniqueness invariants
- `web-ui/tests/agent-ops/slack-validator.property.test.ts` — Slack validator invariants
- Uses `fast-check` ^4.5.3; `fc.assert` + `fc.property` pattern; `numRuns: 200`

**Unit Tests (Vitest — Lambda scheduler):**
- Location: `lambda/scheduler/src/services/dynamodb-service.test.ts`

**CDK Infrastructure Tests (Jest):**
- Location: `test/cdk-2.test.ts`
- Status: all test assertions commented out — effectively no CDK coverage

**E2E Tests (Playwright):**
- Location: `tests/e2e/`
- Files:
  - `tests/e2e/accounts.spec.ts` — AWS Accounts module (~45KB, 60+ tests)
  - `tests/e2e/navigation.spec.ts` — App navigation flows
  - `tests/e2e/marketing.spec.ts` — Marketing/landing page
  - `tests/e2e/docs.spec.ts` — Documentation pages
  - `tests/e2e/auth.setup.ts` — Session setup (runs once before all tests)

**Python/Notebook Tests:**
- `web-ui/tests/e2e_agent_test.ipynb` — Jupyter notebook for agent testing (not part of CI)
- `web-ui/tests/requirements.txt` — Python requirements for notebook tests

## Test Conventions

**File Naming:**
- Unit tests: `<module>.test.ts` colocated in `tests/` subdirectory mirroring `lib/`
- Property tests: `<module>.property.test.ts`
- E2E specs: `<feature>.spec.ts` in `tests/e2e/`
- E2E auth setup: `auth.setup.ts` (matched by `playwright.config.ts` `testMatch: /auth\.setup\.ts/`)

**Unit Test Structure:**
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 1. Hoist mock functions with vi.hoisted()
const { mockFn } = vi.hoisted(() => ({ mockFn: vi.fn() }));

// 2. vi.mock() factories before any imports
vi.mock('../../lib/some-module', () => ({ SomeClass: { method: mockFn } }));

// 3. Import subject under test AFTER mocks
import { functionUnderTest } from '../../lib/service';

// 4. describe/it blocks
describe('functionUnderTest', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('does the thing', async () => {
        mockFn.mockResolvedValue({ id: 'test-id' });
        const result = await functionUnderTest();
        expect(result).toEqual({ id: 'test-id' });
    });
});
```

**Mocking Pattern:**
- `vi.hoisted()` required for mock functions used inside `vi.mock()` factory scope
- AWS SDK clients are mocked wholesale to avoid real AWS initialization
- `vi.resetModules()` used when re-importing a module with different env vars (see `slack-validator.test.ts`)
- Module mocks always specify full relative path from test file to module

**Property Test Structure:**
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

**E2E Test Structure:**
```typescript
import { test, expect, Page } from '@playwright/test';

// Helper function for shared navigation
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

**E2E Auth:**
- Session minted once in `tests/e2e/auth.setup.ts` by JWT-encoding a test user token
- Stored in `tests/e2e/.auth/session.json` as `storageState`
- All non-setup tests depend on the `setup` project and inherit the session cookie

**Locator Preference (E2E):**
1. `page.getByRole()` — semantic, preferred
2. `page.getByText()` — for visible text content
3. `page.getByLabel()` — for form inputs
4. `page.getByTestId()` — when `data-testid` is added to components

**Never use `waitForTimeout`** — use `expect(...).toBeVisible({ timeout: N })` or `waitForLoadState` instead.

## Running Tests

```bash
# web-ui unit + property tests (Vitest)
cd web-ui && npm run test          # Run once (vitest run)
cd web-ui && npm run test:watch    # Watch mode (vitest)

# CDK tests (Jest)
npm test                           # Run at repo root

# Lambda scheduler tests (Vitest)
cd lambda/scheduler && npm run test

# E2E tests (Playwright) — requires dev server running or auto-starts it
npx playwright test                           # All E2E tests
npx playwright test tests/e2e/accounts.spec.ts  # Specific spec
npx playwright test --headed                  # Headed mode
npx playwright test --ui                      # Interactive UI mode
npx playwright show-report                    # View last HTML report

# Coverage (web-ui)
cd web-ui && npx vitest run --coverage
```

## Gaps

**CDK Infrastructure Tests:**
- `test/cdk-2.test.ts` — all CloudFormation assertions are commented out
- No test coverage for any CDK stack (NetworkingStack, ComputeStack, WebUIStack)
- Risk: infrastructure changes deploy unvalidated

**API Route Tests:**
- No unit or integration tests for any `web-ui/app/api/` routes
- All 18 API route directories (`accounts/`, `schedules/`, `inventory/`, etc.) are untested
- Risk: regressions in auth, error handling, and data mapping go undetected

**React Component Tests:**
- No component-level tests (no jsdom setup, no React Testing Library)
- All component testing is done via E2E only
- Risk: component prop changes and edge cases are not caught until E2E

**Lambda Functions (except scheduler):**
- `lambda/discovery/` (Python) — no test files
- `lambda/vector_processor/` — no test files
- `lambda/kb_sync_processor/` — no test files
- Only `lambda/scheduler/src/services/dynamodb-service.test.ts` exists for lambdas

**E2E Coverage Gaps:**
- No E2E tests for `schedules/`, `inventory/`, `audit/`, `knowledge-base/`, or agent chat flows
- `tests/e2e/` only covers `accounts`, `navigation`, `marketing`, and `docs`
- Agent AI interaction flows (chat, Ask AI dialog) have no automated E2E coverage

**Coverage Enforcement:**
- No coverage thresholds configured in `web-ui/vitest.config.ts`
- `@vitest/coverage-v8` is installed but not run in CI by default

---

*Testing analysis: 2026-03-26*
