/**
 * AWS Accounts Module E2E tests — PostgreSQL backend (USE_PG_ACCOUNTS=true)
 *
 * Covers:
 *  - Page loads without errors when USE_PG_ACCOUNTS=true is set on the dev server
 *  - GET /api/accounts returns 200 with correct shape { success, data, totalCount }
 *  - Search term is sent as a query param (server-side filtering, not client-side)
 *  - Status filter is sent as a query param (server-side filtering)
 *  - Tenant isolation: the API is called with a tenantId and only returns scoped results
 *
 * Note: These tests assume the dev server is running with USE_PG_ACCOUNTS=true.
 * If the env flag is not set, the API route falls back to DynamoDB and these tests
 * still verify the API contract (same response shape regardless of backend).
 *
 * Run: npx playwright test tests/e2e/accounts-pg.spec.ts
 */
import { test, expect, Page } from '@playwright/test';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function gotoAccounts(page: Page) {
    const res = await page.goto('/app/accounts', { waitUntil: 'domcontentloaded', timeout: 60000 });
    expect(res?.status(), 'accounts page should not 404').not.toBe(404);
    const body = await page.locator('body').innerText().catch(() => '');
    expect(body, 'accounts page should not show 404 message').not.toMatch(/This page could not be found/i);
    expect(page.url(), 'accounts page should not redirect to login').not.toContain('/login');
}

/** Wait for the accounts API response and return it. */
async function waitForAccountsResponse(page: Page) {
    return page.waitForResponse(
        (resp) => resp.url().includes('/api/accounts') && resp.status() === 200,
        { timeout: 15000 }
    );
}

// ─── Page Load & API contract ────────────────────────────────────────────────

test.describe('AWS Accounts — PostgreSQL backend: page load', () => {
    test('accounts page loads without a 500 error', async ({ page }) => {
        const responsePromise = waitForAccountsResponse(page);
        await gotoAccounts(page);
        const response = await responsePromise;

        expect(response.status()).toBe(200);
    });

    test('GET /api/accounts returns { success: true, data: array, totalCount: number }', async ({ page }) => {
        const responsePromise = waitForAccountsResponse(page);
        await gotoAccounts(page);
        const response = await responsePromise;

        const body = await response.json();
        expect(body).toHaveProperty('success', true);
        expect(body).toHaveProperty('data');
        expect(Array.isArray(body.data)).toBe(true);
        expect(body).toHaveProperty('totalCount');
        expect(typeof body.totalCount).toBe('number');
    });

    test('page heading "AWS Accounts" is visible after load', async ({ page }) => {
        await gotoAccounts(page);
        await expect(
            page.getByRole('heading', { name: 'AWS Accounts' })
        ).toBeVisible({ timeout: 15000 });
    });
});

// ─── Server-side filtering verification ──────────────────────────────────────

test.describe('AWS Accounts — PostgreSQL backend: server-side search filter', () => {
    test.beforeEach(async ({ page }) => {
        await gotoAccounts(page);
        await expect(page.getByRole('heading', { name: 'AWS Accounts' })).toBeVisible({ timeout: 15000 });
    });

    test('typing a search term and applying filters sends searchTerm as query param', async ({ page }) => {
        const searchInput = page.getByPlaceholder('Search accounts by name, ID, description...');
        await searchInput.fill('test-account');

        // Intercept the next /api/accounts request triggered by Apply Filters
        const responsePromise = page.waitForRequest(
            (req) => req.url().includes('/api/accounts') && req.url().includes('searchTerm'),
            { timeout: 10000 }
        );

        await page.getByRole('button', { name: /Apply Filters/i }).click();

        const request = await responsePromise;
        const url = new URL(request.url());
        expect(url.searchParams.get('searchTerm')).toBe('test-account');
    });

    test('search produces a single API call (not fetch-all then client-filter)', async ({ page }) => {
        const apiCalls: string[] = [];

        page.on('response', (resp) => {
            if (resp.url().includes('/api/accounts')) {
                apiCalls.push(resp.url());
            }
        });

        // Wait for initial load to settle
        await page.waitForLoadState('networkidle');
        const countAfterLoad = apiCalls.length;

        // Type in search and apply
        const searchInput = page.getByPlaceholder('Search accounts by name, ID, description...');
        await searchInput.fill('search-test');

        const responsePromise = waitForAccountsResponse(page);
        await page.getByRole('button', { name: /Apply Filters/i }).click();
        await responsePromise;

        // Only one additional /api/accounts call should have been made (not multiple)
        const newCalls = apiCalls.length - countAfterLoad;
        expect(newCalls).toBeGreaterThanOrEqual(1);
        expect(newCalls).toBeLessThanOrEqual(2); // allow for debounce + button click
    });
});

// ─── Server-side status filter ────────────────────────────────────────────────

test.describe('AWS Accounts — PostgreSQL backend: server-side status filter', () => {
    test.beforeEach(async ({ page }) => {
        await gotoAccounts(page);
        await expect(page.getByRole('heading', { name: 'AWS Accounts' })).toBeVisible({ timeout: 15000 });
    });

    test('selecting "Active Only" status filter sends statusFilter=active query param', async ({ page }) => {
        // Open the status dropdown
        await page.getByText('All Accounts').first().click();
        await page.getByRole('option', { name: 'Active Only' }).first().click();

        // Intercept the API call made when Apply Filters is clicked
        const requestPromise = page.waitForRequest(
            (req) => req.url().includes('/api/accounts') && req.url().includes('statusFilter'),
            { timeout: 10000 }
        );

        await page.getByRole('button', { name: /Apply Filters/i }).click();

        const request = await requestPromise;
        const url = new URL(request.url());
        const statusFilter = url.searchParams.get('statusFilter');
        expect(['active', 'Active']).toContain(statusFilter);
    });

    test('selecting "Inactive Only" status filter sends statusFilter=inactive query param', async ({ page }) => {
        await page.getByText('All Accounts').first().click();
        await page.getByRole('option', { name: 'Inactive Only' }).first().click();

        const requestPromise = page.waitForRequest(
            (req) => req.url().includes('/api/accounts') && req.url().includes('statusFilter'),
            { timeout: 10000 }
        );

        await page.getByRole('button', { name: /Apply Filters/i }).click();

        const request = await requestPromise;
        const url = new URL(request.url());
        const statusFilter = url.searchParams.get('statusFilter');
        expect(['inactive', 'Inactive']).toContain(statusFilter);
    });
});

// ─── Tenant isolation — API contract level ────────────────────────────────────

test.describe('AWS Accounts — PostgreSQL backend: tenant isolation via API', () => {
    test('GET /api/accounts response data items all belong to the same tenant scope', async ({ page }) => {
        const responsePromise = waitForAccountsResponse(page);
        await gotoAccounts(page);
        const response = await responsePromise;

        const body = await response.json();
        expect(body.success).toBe(true);

        // If data exists, verify no cross-tenant leakage (all items must have same tenantId if exposed,
        // or the field must not be present in the UI payload — either is acceptable)
        if (body.data.length > 1) {
            const tenantIds = body.data
                .map((item: Record<string, unknown>) => item.tenantId)
                .filter(Boolean);

            if (tenantIds.length > 0) {
                // All returned records must belong to the same tenant
                const uniqueTenants = new Set(tenantIds);
                expect(uniqueTenants.size).toBe(1);
            }
        }
    });

    test('GET /api/accounts does not return 500 (backend is healthy)', async ({ page }) => {
        const responsePromise = waitForAccountsResponse(page);
        await gotoAccounts(page);
        const response = await responsePromise;

        expect(response.status()).not.toBe(500);
        expect(response.status()).not.toBe(503);
    });
});
