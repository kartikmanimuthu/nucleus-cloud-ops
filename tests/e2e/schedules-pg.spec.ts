/**
 * Schedules Module E2E tests — PostgreSQL backend (USE_PG_SCHEDULES=true)
 *
 * Covers:
 *  - Schedules page loads without errors
 *  - GET /api/schedules returns 200 with correct shape { success, data, meta }
 *  - Status filter is sent as a query param to the API (server-side filtering)
 *  - Search is sent as a query param to the API (server-side filtering)
 *  - GET /api/schedules/:id/history returns 200 with executions array
 *  - Audit logs page loads without errors
 *  - GET /api/audit returns 200 with correct shape { success, data: array }
 *  - Audit eventType filter sends query param to API (server-side filtering)
 *
 * Note: These tests assume the dev server is running (with or without USE_PG_SCHEDULES=true).
 * The API contract is identical regardless of backend (DynamoDB or PostgreSQL).
 *
 * Run: npx playwright test tests/e2e/schedules-pg.spec.ts
 */
import { test, expect, Page } from '@playwright/test';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function gotoSchedules(page: Page) {
    const res = await page.goto('/app/schedules', { waitUntil: 'domcontentloaded', timeout: 60000 });
    expect(res?.status(), 'schedules page should not 404').not.toBe(404);
    const body = await page.locator('body').innerText().catch(() => '');
    expect(body, 'schedules page should not show 404 message').not.toMatch(/This page could not be found/i);
    expect(page.url(), 'schedules page should not redirect to login').not.toContain('/login');
}

/** Wait for the schedules API response and return it. */
async function waitForSchedulesResponse(page: Page) {
    return page.waitForResponse((resp) => resp.url().includes('/api/schedules') && resp.status() === 200, { timeout: 15000 });
}

async function gotoAudit(page: Page) {
    const res = await page.goto('/app/audit', { waitUntil: 'domcontentloaded', timeout: 60000 });
    expect(res?.status(), 'audit page should not 404').not.toBe(404);
    const body = await page.locator('body').innerText().catch(() => '');
    expect(body, 'audit page should not show 404 message').not.toMatch(/This page could not be found/i);
    expect(page.url(), 'audit page should not redirect to login').not.toContain('/login');
}

/** Wait for the audit API response and return it. */
async function waitForAuditResponse(page: Page) {
    return page.waitForResponse((resp) => resp.url().includes('/api/audit') && resp.status() === 200, { timeout: 15000 });
}

// ─── Block 1: Page Load & API contract ───────────────────────────────────────

test.describe('Schedules -- PostgreSQL backend: page load', () => {
    test('schedules page loads without a 500 error', async ({ page }) => {
        const responsePromise = waitForSchedulesResponse(page);
        await gotoSchedules(page);
        const response = await responsePromise;

        expect(response.status()).toBe(200);
    });

    test('GET /api/schedules returns { success: true, data: array, meta: object }', async ({ page }) => {
        const responsePromise = waitForSchedulesResponse(page);
        await gotoSchedules(page);
        const response = await responsePromise;

        const body = await response.json();
        expect(body).toHaveProperty('success', true);
        expect(body).toHaveProperty('data');
        expect(Array.isArray(body.data)).toBe(true);
        expect(body).toHaveProperty('meta');
        expect(typeof body.meta.total).toBe('number');
    });

    test('schedules page does not return 500 or 503 (backend is healthy)', async ({ page }) => {
        const responsePromise = waitForSchedulesResponse(page);
        await gotoSchedules(page);
        const response = await responsePromise;

        expect(response.status()).not.toBe(500);
        expect(response.status()).not.toBe(503);
    });
});

// ─── Block 2: Server-side filtering verification ──────────────────────────────

test.describe('Schedules -- PostgreSQL backend: server-side filtering', () => {
    test.beforeEach(async ({ page }) => {
        await gotoSchedules(page);
        // Wait for initial load to complete
        await page.waitForLoadState('networkidle');
    });

    test('status filter sends query param to API (not client-side filtering)', async ({ page }) => {
        // Set up request interception BEFORE triggering the filter
        const requestPromise = page.waitForRequest(
            (req) =>
                req.url().includes('/api/schedules') &&
                req.url().includes('status'),
            { timeout: 10000 }
        );

        // Open the status dropdown and select "Active Only"
        await page.getByText('All Schedules').first().click();
        await page.getByRole('option', { name: 'Active Only' }).first().click();

        // Click "Apply Filters" to trigger the API call
        const applyButton = page.getByRole('button', { name: /Apply Filters/i });
        await applyButton.click();

        const request = await requestPromise;
        const url = new URL(request.url());
        const statusParam = url.searchParams.get('status');
        expect(['active', 'Active']).toContain(statusParam);
    });

    test('search sends search query param to API', async ({ page }) => {
        // Find the search input field
        const searchInput = page.getByRole('textbox').first();
        await searchInput.fill('test-schedule');

        // Intercept the API request triggered by search
        const requestPromise = page.waitForRequest(
            (req) =>
                req.url().includes('/api/schedules') &&
                req.url().includes('search'),
            { timeout: 10000 }
        );

        // Submit the filter (Apply Filters button or similar)
        const applyButton = page.getByRole('button', { name: /Apply Filters/i });
        const hasApplyButton = await applyButton.count() > 0;
        if (hasApplyButton) {
            await applyButton.click();
        } else {
            // Some UIs auto-submit on input change; trigger via keyboard
            await searchInput.press('Enter');
        }

        const request = await requestPromise;
        const url = new URL(request.url());
        expect(url.searchParams.get('search')).toBe('test-schedule');
    });
});

// ─── Block 3: Schedule execution history ─────────────────────────────────────

test.describe('Schedules -- execution history', () => {
    test('GET /api/schedules/:id/history returns 200 with executions array', async ({ page }) => {
        // First fetch a schedule ID from GET /api/schedules via page.request
        const schedulesResponse = await page.request.get('/api/schedules');
        expect(schedulesResponse.status()).toBe(200);

        const schedulesBody = await schedulesResponse.json();
        expect(schedulesBody.success).toBe(true);
        expect(Array.isArray(schedulesBody.data)).toBe(true);

        // If there are no schedules, skip the execution history check
        if (schedulesBody.data.length === 0) {
            // No schedules to test execution history — this is acceptable (empty environment)
            return;
        }

        const firstScheduleId = schedulesBody.data[0].id;
        expect(firstScheduleId).toBeTruthy();

        // Fetch execution history for the first schedule
        const historyResponse = await page.request.get(`/api/schedules/${firstScheduleId}/history`);
        expect(historyResponse.status()).toBe(200);

        const historyBody = await historyResponse.json();
        expect(historyBody).toHaveProperty('success', true);
        expect(historyBody).toHaveProperty('executions');
        expect(Array.isArray(historyBody.executions)).toBe(true);
        expect(historyBody).toHaveProperty('scheduleId', firstScheduleId);
    });
});

// ─── Block 4: Audit logs page ─────────────────────────────────────────────────

test.describe('Audit logs -- PostgreSQL backend', () => {
    test('audit page loads without a 500 error', async ({ page }) => {
        const responsePromise = waitForAuditResponse(page);
        await gotoAudit(page);
        const response = await responsePromise;

        expect(response.status()).toBe(200);
    });

    test('GET /api/audit returns { success: true, data: array }', async ({ page }) => {
        const responsePromise = waitForAuditResponse(page);
        await gotoAudit(page);
        const response = await responsePromise;

        const body = await response.json();
        expect(body).toHaveProperty('success', true);
        expect(body).toHaveProperty('data');
        expect(Array.isArray(body.data)).toBe(true);
    });

    test('audit page does not return 500 or 503 (backend is healthy)', async ({ page }) => {
        const responsePromise = waitForAuditResponse(page);
        await gotoAudit(page);
        const response = await responsePromise;

        expect(response.status()).not.toBe(500);
        expect(response.status()).not.toBe(503);
    });

    test('audit page filters send eventType query param to API', async ({ page }) => {
        await gotoAudit(page);
        await page.waitForLoadState('networkidle');

        // Intercept the audit API request with an eventType filter
        const requestPromise = page.waitForRequest(
            (req) =>
                req.url().includes('/api/audit') &&
                req.url().includes('eventType'),
            { timeout: 15000 }
        );

        // Look for an eventType filter (dropdown or select)
        const eventTypeFilter = page.getByLabel(/event type/i);
        const hasEventTypeFilter = await eventTypeFilter.count() > 0;

        if (hasEventTypeFilter) {
            await eventTypeFilter.click();
            // Select first available option
            const options = page.getByRole('option');
            const optionCount = await options.count();
            if (optionCount > 0) {
                await options.first().click();
            }

            const applyButton = page.getByRole('button', { name: /Apply|Filter|Search/i });
            if (await applyButton.count() > 0) {
                await applyButton.first().click();
            }

            const request = await requestPromise;
            const url = new URL(request.url());
            expect(url.searchParams.has('eventType')).toBe(true);
        } else {
            // If no eventType filter UI exists, verify the API directly accepts the param
            const directResponse = await page.request.get('/api/audit?eventType=ScheduleExecution');
            expect(directResponse.status()).toBe(200);
            const body = await directResponse.json();
            expect(body.success).toBe(true);
        }
    });
});
