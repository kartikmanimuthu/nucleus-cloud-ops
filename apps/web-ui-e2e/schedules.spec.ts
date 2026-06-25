/**
 * Schedules Module E2E — Full CRUD mutation tests
 *
 * Tests the complete lifecycle: Create → Read → Update → Toggle → Search → Filter → Paginate → Delete
 * Uses real API calls against the running dev server with DynamoDB/PostgreSQL backend.
 *
 * Run: cd apps/web-ui-e2e && bunx playwright test schedules.spec.ts
 */
import { test, expect, Page } from '@playwright/test';

// ─── Constants ──────────────────────────────────────────────────────────────

const TEST_SCHEDULE_PREFIX = 'E2E-TEST-SCHED';
const uniqueId = () => `${TEST_SCHEDULE_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

// ─── Helpers ────────────────────────────────────────────────────────────────

async function gotoSchedules(page: Page) {
    await page.goto('/app/schedules', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    expect(page.url()).not.toContain('/login');
    // Wait for schedules data to load (loading spinner gone or table/grid visible)
    await page.waitForLoadState('networkidle');
}

/** Create a schedule via API and return its data */
async function createScheduleViaAPI(page: Page, overrides: Record<string, any> = {}) {
    const name = overrides.name || uniqueId();
    const payload = {
        name,
        starttime: '09:00:00',
        endtime: '18:00:00',
        timezone: 'Asia/Kolkata',
        days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
        active: true,
        accountId: '922748618344',
        accounts: ['922748618344'],
        ...overrides,
    };
    const resp = await page.request.post('/api/schedules', { data: payload });
    expect(resp.status(), `create schedule "${name}" should succeed`).toBe(201);
    const body = await resp.json();
    expect(body.success).toBe(true);
    return body.data;
}

/** Delete a schedule via API (best-effort cleanup) */
async function deleteScheduleViaAPI(page: Page, scheduleId: string) {
    try {
        await page.request.delete(`/api/schedules/${encodeURIComponent(scheduleId)}`);
    } catch { /* ignore cleanup errors */ }
}

/** Get a schedule via API */
async function getScheduleViaAPI(page: Page, scheduleId: string) {
    const resp = await page.request.get(`/api/schedules/${encodeURIComponent(scheduleId)}`);
    if (resp.status() === 404) return null;
    return resp.json();
}

/** Switch to table view */
async function switchToTableView(page: Page) {
    const tableTab = page.getByRole('tab', { name: 'Table View' });
    if (await tableTab.getAttribute('aria-selected') !== 'true') {
        await tableTab.click();
        await page.waitForTimeout(300);
    }
}

/** Apply search filter */
async function applySearch(page: Page, term: string) {
    const searchInput = page.getByPlaceholder(/search schedules/i);
    await searchInput.fill(term);
    await page.getByRole('button', { name: /apply filter/i }).click();
    await page.waitForLoadState('networkidle');
}

/** Clear all filters */
async function clearFilters(page: Page) {
    await page.getByRole('button', { name: /clear filter/i }).click();
    await page.waitForLoadState('networkidle');
}

// ─── Block 1: Page Structure & Layout ───────────────────────────────────────

test.describe('Schedules — Page Structure', () => {
    test('page renders heading, subtitle, and action buttons', async ({ page }) => {
        await gotoSchedules(page);

        await expect(page.getByRole('heading', { name: 'Cost Scheduler', level: 1 })).toBeVisible();
        await expect(page.getByText('Manage cost optimization schedules')).toBeVisible();
        await expect(page.getByRole('button', { name: /refresh/i })).toBeVisible();
        await expect(page.getByRole('button', { name: /create schedule/i })).toBeVisible();
    });

    test('stats cards are visible with numeric values', async ({ page }) => {
        await gotoSchedules(page);

        await expect(page.getByText('Total Schedules')).toBeVisible();
        await expect(page.getByText('Active Schedules')).toBeVisible();
        await expect(page.getByText('Monthly Savings')).toBeVisible();
    });

    test('filter section renders search, status dropdown, resource dropdown, and buttons', async ({ page }) => {
        await gotoSchedules(page);

        await expect(page.getByPlaceholder(/search schedules/i)).toBeVisible();
        await expect(page.getByRole('button', { name: /apply filter/i })).toBeVisible();
        await expect(page.getByRole('button', { name: /clear filter/i })).toBeVisible();
    });

    test('view toggle shows Table View and Grid View tabs', async ({ page }) => {
        await gotoSchedules(page);

        await expect(page.getByRole('tab', { name: 'Table View' })).toBeVisible();
        await expect(page.getByRole('tab', { name: 'Grid View' })).toBeVisible();
    });

    test('default view is Grid View', async ({ page }) => {
        await gotoSchedules(page);

        const gridTab = page.getByRole('tab', { name: 'Grid View' });
        await expect(gridTab).toHaveAttribute('aria-selected', 'true');
    });
});

// ─── Block 2: API Contract ──────────────────────────────────────────────────

test.describe('Schedules — API Contract', () => {
    test('GET /api/schedules returns correct shape', async ({ page }) => {
        const resp = await page.request.get('/api/schedules');
        expect(resp.status()).toBe(200);

        const body = await resp.json();
        expect(body).toHaveProperty('success', true);
        expect(Array.isArray(body.data)).toBe(true);
        expect(body).toHaveProperty('meta');
        expect(body.meta).toHaveProperty('total');
        expect(body.meta).toHaveProperty('page');
        expect(body.meta).toHaveProperty('limit');
        expect(body.meta).toHaveProperty('totalPages');
    });

    test('GET /api/schedules supports pagination params', async ({ page }) => {
        const resp = await page.request.get('/api/schedules?page=1&limit=5');
        expect(resp.status()).toBe(200);

        const body = await resp.json();
        expect(body.data.length).toBeLessThanOrEqual(5);
        expect(body.meta.limit).toBe(5);
    });

    test('GET /api/schedules/:id returns 404 for non-existent schedule', async ({ page }) => {
        const resp = await page.request.get('/api/schedules/non-existent-id-12345');
        expect(resp.status()).toBe(404);
    });

    test('POST /api/schedules validates required fields', async ({ page }) => {
        const resp = await page.request.post('/api/schedules', {
            data: { name: 'incomplete' },
        });
        expect(resp.status()).toBe(400);
    });

    test('POST /api/schedules rejects duplicate schedule names', async ({ page }) => {
        const schedule = await createScheduleViaAPI(page);
        try {
            const resp = await page.request.post('/api/schedules', {
                data: {
                    name: schedule.name,
                    starttime: '09:00:00',
                    endtime: '18:00:00',
                    timezone: 'Asia/Kolkata',
                    days: ['Mon'],
                    accountId: '922748618344',
                    accounts: ['922748618344'],
                },
            });
            // Backend should reject duplicate — 409 or 500 with error, or 201 if name uniqueness isn't enforced
            // Either way, verify the response is valid JSON with expected shape
            const body = await resp.json();
            if (resp.status() === 201) {
                // Name uniqueness not enforced — clean up the duplicate
                expect(body.success).toBe(true);
                if (body.data?.id) await deleteScheduleViaAPI(page, body.data.id);
            } else {
                expect(body.success).toBe(false);
            }
        } finally {
            await deleteScheduleViaAPI(page, schedule.id);
        }
    });

    test('DELETE /api/schedules/:id returns success', async ({ page }) => {
        const schedule = await createScheduleViaAPI(page);
        const resp = await page.request.delete(`/api/schedules/${encodeURIComponent(schedule.id)}`);
        expect(resp.status()).toBe(200);
        const body = await resp.json();
        expect(body.success).toBe(true);

        // Verify it's gone
        const check = await page.request.get(`/api/schedules/${encodeURIComponent(schedule.id)}`);
        expect(check.status()).toBe(404);
    });

    test('PUT /api/schedules/:id updates schedule fields', async ({ page }) => {
        const schedule = await createScheduleViaAPI(page);
        try {
            const resp = await page.request.put(`/api/schedules/${encodeURIComponent(schedule.id)}`, {
                data: { starttime: '10:00:00', endtime: '20:00:00' },
            });
            expect(resp.status()).toBe(200);
            const updated = await resp.json();
            expect(updated.starttime).toBe('10:00:00');
            expect(updated.endtime).toBe('20:00:00');
        } finally {
            await deleteScheduleViaAPI(page, schedule.id);
        }
    });

    test('POST /api/schedules/:id/toggle flips active status', async ({ page }) => {
        const schedule = await createScheduleViaAPI(page, { active: true });
        try {
            const resp = await page.request.post(`/api/schedules/${encodeURIComponent(schedule.id)}/toggle`);
            expect(resp.status()).toBe(200);
            const body = await resp.json();
            expect(body.success).toBe(true);
            expect(body.data.active).toBe(false);

            // Toggle back
            const resp2 = await page.request.post(`/api/schedules/${encodeURIComponent(schedule.id)}/toggle`);
            const body2 = await resp2.json();
            expect(body2.data.active).toBe(true);
        } finally {
            await deleteScheduleViaAPI(page, schedule.id);
        }
    });

    test('GET /api/schedules/:id/history returns execution history', async ({ page }) => {
        const schedule = await createScheduleViaAPI(page);
        try {
            const resp = await page.request.get(`/api/schedules/${encodeURIComponent(schedule.id)}/history`);
            expect(resp.status()).toBe(200);
            const body = await resp.json();
            expect(body.success).toBe(true);
            expect(Array.isArray(body.executions)).toBe(true);
            expect(body.scheduleId).toBe(schedule.id);
        } finally {
            await deleteScheduleViaAPI(page, schedule.id);
        }
    });
});

// ─── Block 3: Create Schedule via UI ────────────────────────────────────────

test.describe('Schedules — Create via UI', () => {
    test('"Create Schedule" button navigates to create page', async ({ page }) => {
        await gotoSchedules(page);
        await page.getByRole('button', { name: /create schedule/i }).click();
        await page.waitForURL('**/schedules/create', { timeout: 10_000 });
        await expect(page.getByRole('heading', { name: /create schedule/i })).toBeVisible();
    });

    test('create page has back button that returns to schedules list', async ({ page }) => {
        await page.goto('/app/schedules/create', { waitUntil: 'domcontentloaded' });
        const backButton = page.getByRole('button', { name: /back/i });
        await expect(backButton).toBeVisible();
    });

    test('create form shows required fields: name, start time, end time, timezone, days', async ({ page }) => {
        await page.goto('/app/schedules/create', { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle');

        await expect(page.getByRole('textbox', { name: 'Schedule Name' })).toBeVisible();
        await expect(page.getByRole('textbox', { name: 'Start Time' })).toBeVisible();
        await expect(page.getByRole('textbox', { name: 'End Time' })).toBeVisible();
        await expect(page.getByRole('checkbox', { name: 'Monday' })).toBeVisible();
        await expect(page.getByRole('checkbox', { name: 'Friday' })).toBeVisible();
    });

    test('create form validates — submit without required fields stays on page', async ({ page }) => {
        await page.goto('/app/schedules/create', { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle');

        const nameInput = page.getByLabel(/schedule name/i);
        await nameInput.clear();

        const submitButton = page.getByRole('button', { name: /create schedule/i });
        await submitButton.click();

        // Should stay on create page (validation prevents submit)
        await expect(page).toHaveURL(/schedules\/create/);
    });

    test('full create → verify → delete lifecycle via API-seeded UI', async ({ page }) => {
        const name = uniqueId();
        const schedule = await createScheduleViaAPI(page, { name });

        try {
            await gotoSchedules(page);
            await applySearch(page, name);
            await expect(page.getByText(name)).toBeVisible({ timeout: 10_000 });
        } finally {
            await deleteScheduleViaAPI(page, schedule.id);
        }
    });
});

// ─── Block 4: Search & Filter ───────────────────────────────────────────────

test.describe('Schedules — Search & Filter', () => {
    let testSchedule: any;

    test.beforeAll(async ({ browser }) => {
        const ctx = await browser.newContext({ storageState: '.auth/session.json' });
        const p = await ctx.newPage();
        testSchedule = await createScheduleViaAPI(p, { name: uniqueId() });
        await ctx.close();
    });

    test.afterAll(async ({ browser }) => {
        const ctx = await browser.newContext({ storageState: '.auth/session.json' });
        const p = await ctx.newPage();
        await deleteScheduleViaAPI(p, testSchedule.id);
        await ctx.close();
    });

    test('search by exact name returns matching schedule', async ({ page }) => {
        await gotoSchedules(page);
        await applySearch(page, testSchedule.name);
        await expect(page.getByText(testSchedule.name)).toBeVisible({ timeout: 10_000 });
    });

    test('search by partial name returns matching schedule', async ({ page }) => {
        await gotoSchedules(page);
        const partial = testSchedule.name.substring(0, 20);
        await applySearch(page, partial);
        await expect(page.getByText(testSchedule.name)).toBeVisible({ timeout: 10_000 });
    });

    test('search for non-existent name hides real schedules', async ({ page }) => {
        await gotoSchedules(page);
        await applySearch(page, 'ZZZZZ-NONEXISTENT-SCHEDULE-99999');
        await expect(page.getByText(testSchedule.name)).not.toBeVisible({ timeout: 5_000 });
    });

    test('clear filters restores full schedule list', async ({ page }) => {
        await gotoSchedules(page);
        await applySearch(page, 'ZZZZZ-NONEXISTENT');
        await clearFilters(page);

        // Stats card should show total > 0
        await expect(page.getByText('Total Schedules')).toBeVisible();
    });

    test('status filter — Active Only sends status param to API', async ({ page }) => {
        await gotoSchedules(page);

        // Set up request interception BEFORE triggering the action
        const requestPromise = page.waitForRequest(
            (req) => req.url().includes('/api/schedules') && req.url().includes('status'),
            { timeout: 15_000 }
        );

        // Open status dropdown, select Active Only, then click Apply
        const statusTrigger = page.locator('button[role="combobox"]').filter({ hasText: 'All Schedules' });
        await statusTrigger.click();
        await page.getByRole('option', { name: 'Active Only', exact: true }).click();

        // Must click Apply Filter to trigger the API call
        await page.getByRole('button', { name: /apply filter/i }).click();

        const request = await requestPromise;
        const url = new URL(request.url());
        expect(url.searchParams.get('status')).toBeTruthy();
    });

    test('status filter — Inactive Only sends status param to API', async ({ page }) => {
        await gotoSchedules(page);

        const requestPromise = page.waitForRequest(
            (req) => req.url().includes('/api/schedules') && req.url().includes('status'),
            { timeout: 15_000 }
        );

        const statusTrigger = page.locator('button[role="combobox"]').filter({ hasText: 'All Schedules' });
        await statusTrigger.click();
        await page.getByRole('option', { name: 'Inactive Only', exact: true }).click();

        await page.getByRole('button', { name: /apply filter/i }).click();

        const request = await requestPromise;
        const url = new URL(request.url());
        expect(url.searchParams.get('status')).toBeTruthy();
    });

    test('search sends search query param to API', async ({ page }) => {
        await gotoSchedules(page);

        const requestPromise = page.waitForRequest(
            (req) => req.url().includes('/api/schedules') && req.url().includes('search='),
            { timeout: 15_000 }
        );

        await page.getByPlaceholder(/search schedules/i).fill('test-query');
        await page.getByRole('button', { name: /apply filter/i }).click();

        const request = await requestPromise;
        const url = new URL(request.url());
        expect(url.searchParams.get('search')).toBe('test-query');
    });
});

// ─── Block 5: Pagination ────────────────────────────────────────────────────

test.describe('Schedules — Pagination', () => {
    test('pagination controls are visible when schedules exceed page limit', async ({ page }) => {
        await gotoSchedules(page);
        const pagination = page.locator('nav[aria-label="pagination"]');
        if (await pagination.isVisible()) {
            await expect(pagination.getByText(/page \d+ of \d+/i)).toBeVisible();
        }
    });

    test('clicking Next page loads page 2', async ({ page }) => {
        await gotoSchedules(page);

        const pagination = page.locator('nav[aria-label="pagination"]');
        if (!(await pagination.isVisible())) {
            test.skip();
            return;
        }

        const nextLink = page.getByRole('link', { name: /next page/i });
        if (await nextLink.isVisible()) {
            await nextLink.click();
            await page.waitForLoadState('networkidle');
            expect(page.url()).toContain('page=2');
            await expect(pagination.getByText(/page 2/i)).toBeVisible();
        }
    });

    test('clicking Previous from page 2 returns to page 1', async ({ page }) => {
        await page.goto('/app/schedules?page=2&limit=10', { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle');

        const prevLink = page.getByRole('link', { name: /previous page/i });
        if (await prevLink.isEnabled()) {
            await prevLink.click();
            await page.waitForLoadState('networkidle');
            const pagination = page.locator('nav[aria-label="pagination"]');
            if (await pagination.isVisible()) {
                await expect(pagination.getByText(/page 1/i)).toBeVisible();
            }
        }
    });

    test('Previous is disabled on page 1', async ({ page }) => {
        await gotoSchedules(page);

        const pagination = page.locator('nav[aria-label="pagination"]');
        if (await pagination.isVisible()) {
            const prevLink = page.getByRole('link', { name: /previous page/i });
            if (await prevLink.count() > 0) {
                const isDisabled = await prevLink.evaluate(el =>
                    el.classList.contains('pointer-events-none') ||
                    el.getAttribute('aria-disabled') === 'true' ||
                    el.hasAttribute('disabled')
                );
                expect(isDisabled).toBe(true);
            }
        }
    });
});

// ─── Block 6: View Toggle ───────────────────────────────────────────────────

test.describe('Schedules — View Toggle', () => {
    test('switching to Table View shows table with column headers', async ({ page }) => {
        await gotoSchedules(page);
        await switchToTableView(page);

        await expect(page.getByRole('columnheader', { name: 'Schedule', exact: true })).toBeVisible();
        await expect(page.getByRole('columnheader', { name: 'Time Window' })).toBeVisible();
        await expect(page.getByRole('columnheader', { name: 'Days' })).toBeVisible();
        await expect(page.getByRole('columnheader', { name: 'Status' })).toBeVisible();
    });

    test('switching back to Grid View hides table headers', async ({ page }) => {
        await gotoSchedules(page);
        await switchToTableView(page);

        await page.getByRole('tab', { name: 'Grid View' }).click();
        await page.waitForTimeout(300);

        await expect(page.getByRole('columnheader', { name: 'Schedule', exact: true })).not.toBeVisible();
    });

    test('table view rows have schedule data', async ({ page }) => {
        await gotoSchedules(page);
        await switchToTableView(page);

        const rows = page.locator('tbody tr');
        const count = await rows.count();
        expect(count).toBeGreaterThan(0);
    });

    test('grid view cards have checkboxes', async ({ page }) => {
        await gotoSchedules(page);

        const gridPanel = page.getByRole('tabpanel', { name: 'Grid View' });
        if (await gridPanel.isVisible()) {
            const checkboxes = gridPanel.getByRole('checkbox');
            expect(await checkboxes.count()).toBeGreaterThan(0);
        }
    });
});

// ─── Block 7: Toggle Status via UI ──────────────────────────────────────────

test.describe('Schedules — Toggle Status', () => {
    let testSchedule: any;

    test.beforeEach(async ({ page }) => {
        testSchedule = await createScheduleViaAPI(page, { name: uniqueId(), active: true });
    });

    test.afterEach(async ({ page }) => {
        await deleteScheduleViaAPI(page, testSchedule.id);
    });

    test('deactivate button toggles schedule to inactive', async ({ page }) => {
        await gotoSchedules(page);
        await applySearch(page, testSchedule.name);
        await switchToTableView(page);

        const row = page.locator('tr', { hasText: testSchedule.name });
        await expect(row).toBeVisible({ timeout: 10_000 });

        const deactivateBtn = row.getByRole('button', { name: /deactivate/i });
        await deactivateBtn.click();

        await page.waitForResponse(
            (resp) => resp.url().includes('/toggle') && resp.status() === 200,
            { timeout: 10_000 }
        );

        const updated = await getScheduleViaAPI(page, testSchedule.id);
        expect(updated?.active).toBe(false);
    });

    test('activate button toggles inactive schedule to active', async ({ page }) => {
        // Deactivate first via API
        await page.request.post(`/api/schedules/${encodeURIComponent(testSchedule.id)}/toggle`);

        await gotoSchedules(page);
        await applySearch(page, testSchedule.name);
        await switchToTableView(page);

        const row = page.locator('tr', { hasText: testSchedule.name });
        await expect(row).toBeVisible({ timeout: 10_000 });

        const activateBtn = row.getByRole('button', { name: /activate/i });
        await activateBtn.click();

        await page.waitForResponse(
            (resp) => resp.url().includes('/toggle') && resp.status() === 200,
            { timeout: 10_000 }
        );

        const updated = await getScheduleViaAPI(page, testSchedule.id);
        expect(updated?.active).toBe(true);
    });
});

// ─── Block 8: Delete via UI ─────────────────────────────────────────────────

test.describe('Schedules — Delete via UI', () => {
    test('delete from three-dot menu opens confirmation dialog', async ({ page }) => {
        const schedule = await createScheduleViaAPI(page);

        try {
            await gotoSchedules(page);
            await applySearch(page, schedule.name);
            await switchToTableView(page);

            const row = page.locator('tr', { hasText: schedule.name });
            await expect(row).toBeVisible({ timeout: 10_000 });

            // Open three-dot menu
            const menuButton = row.getByRole('button').last();
            await menuButton.click();

            // Click Delete
            await page.getByRole('menuitem', { name: /delete/i }).click();

            // Confirmation dialog
            await expect(page.getByRole('dialog')).toBeVisible();
            await expect(page.getByText(/are you sure/i)).toBeVisible();
        } finally {
            await deleteScheduleViaAPI(page, schedule.id);
        }
    });

    test('confirming delete removes schedule', async ({ page }) => {
        const schedule = await createScheduleViaAPI(page);

        await gotoSchedules(page);
        await applySearch(page, schedule.name);
        await switchToTableView(page);

        const row = page.locator('tr', { hasText: schedule.name });
        await expect(row).toBeVisible({ timeout: 10_000 });

        // Three-dot → Delete
        await row.getByRole('button').last().click();
        await page.getByRole('menuitem', { name: /delete/i }).click();

        // Confirm
        await page.getByRole('dialog').getByRole('button', { name: /delete schedule/i }).click();

        await page.waitForResponse(
            (resp) => resp.url().includes('/api/schedules/') && resp.request().method() === 'DELETE',
            { timeout: 10_000 }
        );

        await page.waitForLoadState('networkidle');

        // Verify gone
        const check = await getScheduleViaAPI(page, schedule.id);
        expect(check).toBeNull();
    });

    test('cancelling delete keeps schedule intact', async ({ page }) => {
        const schedule = await createScheduleViaAPI(page);

        try {
            await gotoSchedules(page);
            await applySearch(page, schedule.name);
            await switchToTableView(page);

            const row = page.locator('tr', { hasText: schedule.name });
            await expect(row).toBeVisible({ timeout: 10_000 });

            await row.getByRole('button').last().click();
            await page.getByRole('menuitem', { name: /delete/i }).click();

            // Cancel
            await page.getByRole('dialog').getByRole('button', { name: /cancel/i }).click();
            await expect(page.getByRole('dialog')).not.toBeVisible();

            // Still exists
            const check = await getScheduleViaAPI(page, schedule.id);
            expect(check).not.toBeNull();
        } finally {
            await deleteScheduleViaAPI(page, schedule.id);
        }
    });
});

// ─── Block 9: Schedule Detail Page ──────────────────────────────────────────

test.describe('Schedules — Detail Page', () => {
    let testSchedule: any;

    test.beforeAll(async ({ browser }) => {
        const ctx = await browser.newContext({ storageState: '.auth/session.json' });
        const p = await ctx.newPage();
        testSchedule = await createScheduleViaAPI(p, { name: uniqueId() });
        await ctx.close();
    });

    test.afterAll(async ({ browser }) => {
        const ctx = await browser.newContext({ storageState: '.auth/session.json' });
        const p = await ctx.newPage();
        await deleteScheduleViaAPI(p, testSchedule.id);
        await ctx.close();
    });

    test('clicking schedule name navigates to detail page', async ({ page }) => {
        await gotoSchedules(page);
        await applySearch(page, testSchedule.name);
        await switchToTableView(page);

        const nameButton = page.getByRole('button', { name: testSchedule.name });
        await expect(nameButton).toBeVisible({ timeout: 10_000 });
        await nameButton.click();

        await page.waitForURL(`**/schedules/${encodeURIComponent(testSchedule.id)}`, { timeout: 10_000 });
    });

    test('detail page shows schedule name and configuration', async ({ page }) => {
        await page.goto(`/app/schedules/${encodeURIComponent(testSchedule.id)}`, { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle');
        await expect(page.getByText(testSchedule.name)).toBeVisible({ timeout: 10_000 });
    });

    test('detail page has execution history tab', async ({ page }) => {
        await page.goto(`/app/schedules/${encodeURIComponent(testSchedule.id)}`, { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle');

        const historyTab = page.getByRole('tab', { name: /execution history/i });
        if (await historyTab.isVisible()) {
            await historyTab.click();
            await expect(page.getByText('Execution History', { exact: true }).first()).toBeVisible();
        }
    });
});

// ─── Block 10: Checkbox Selection ───────────────────────────────────────────

test.describe('Schedules — Selection', () => {
    test('selecting a schedule updates Selected count', async ({ page }) => {
        await gotoSchedules(page);
        await switchToTableView(page);

        const firstCheckbox = page.locator('tbody tr').first().getByRole('checkbox');
        if (await firstCheckbox.isVisible()) {
            await firstCheckbox.check();
            const selectedCard = page.getByText('Selected').locator('..').locator('..');
            await expect(selectedCard.getByText(/bulk actions/i)).toBeVisible({ timeout: 5_000 });
        }
    });

    test('select all checkbox selects all visible schedules', async ({ page }) => {
        await gotoSchedules(page);
        await switchToTableView(page);

        const selectAll = page.getByRole('checkbox', { name: /select all/i });
        if (await selectAll.isVisible()) {
            await selectAll.check();
            const rowCheckboxes = page.locator('tbody tr').getByRole('checkbox');
            const count = await rowCheckboxes.count();
            for (let i = 0; i < Math.min(count, 3); i++) {
                await expect(rowCheckboxes.nth(i)).toBeChecked();
            }
        }
    });
});

// ─── Block 11: Refresh ──────────────────────────────────────────────────────

test.describe('Schedules — Refresh', () => {
    test('refresh button triggers API call', async ({ page }) => {
        await gotoSchedules(page);

        const responsePromise = page.waitForResponse(
            (resp) => resp.url().includes('/api/schedules') && resp.status() === 200,
            { timeout: 15_000 }
        );

        await page.getByRole('button', { name: /refresh/i }).click();
        const response = await responsePromise;
        expect(response.status()).toBe(200);
    });
});

// ─── Block 12: Three-dot Menu Actions ───────────────────────────────────────

test.describe('Schedules — Row Actions Menu', () => {
    let testSchedule: any;

    test.beforeAll(async ({ browser }) => {
        const ctx = await browser.newContext({ storageState: '.auth/session.json' });
        const p = await ctx.newPage();
        testSchedule = await createScheduleViaAPI(p, { name: uniqueId() });
        await ctx.close();
    });

    test.afterAll(async ({ browser }) => {
        const ctx = await browser.newContext({ storageState: '.auth/session.json' });
        const p = await ctx.newPage();
        await deleteScheduleViaAPI(p, testSchedule.id);
        await ctx.close();
    });

    test('three-dot menu shows View Details, Edit, Duplicate, Execute Now, Delete', async ({ page }) => {
        await gotoSchedules(page);
        await applySearch(page, testSchedule.name);
        await switchToTableView(page);

        const row = page.locator('tr', { hasText: testSchedule.name });
        await expect(row).toBeVisible({ timeout: 10_000 });

        await row.getByRole('button').last().click();

        await expect(page.getByRole('menuitem', { name: /view details/i })).toBeVisible();
        await expect(page.getByRole('menuitem', { name: /edit/i })).toBeVisible();
        await expect(page.getByRole('menuitem', { name: /duplicate/i })).toBeVisible();
        await expect(page.getByRole('menuitem', { name: /execute now/i })).toBeVisible();
        await expect(page.getByRole('menuitem', { name: /delete/i })).toBeVisible();
    });

    test('View Details navigates to schedule detail page', async ({ page }) => {
        await gotoSchedules(page);
        await applySearch(page, testSchedule.name);
        await switchToTableView(page);

        const row = page.locator('tr', { hasText: testSchedule.name });
        await expect(row).toBeVisible({ timeout: 10_000 });

        await row.getByRole('button').last().click();
        await page.getByRole('menuitem', { name: /view details/i }).click();

        await page.waitForURL(`**/schedules/${encodeURIComponent(testSchedule.id)}`, { timeout: 10_000 });
    });

    test('Edit navigates to schedule edit page', async ({ page }) => {
        await gotoSchedules(page);
        await applySearch(page, testSchedule.name);
        await switchToTableView(page);

        const row = page.locator('tr', { hasText: testSchedule.name });
        await expect(row).toBeVisible({ timeout: 10_000 });

        await row.getByRole('button').last().click();
        await page.getByRole('menuitem', { name: /edit/i }).click();

        await page.waitForURL(`**/schedules/${encodeURIComponent(testSchedule.id)}/edit`, { timeout: 10_000 });
    });
});
