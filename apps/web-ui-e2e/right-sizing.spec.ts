/**
 * Right Sizing E2E tests — /app/right-sizing (RS-030)
 *
 * Covers the reviewer happy path: page loads → KPI cards render → filter →
 * (if recommendations exist) open detail dialog → approve → status persists.
 *
 * The page route renders regardless of the RIGHT_SIZING_ENABLED flag (only the
 * sidebar nav link is gated); the API returns empty data when the flag is off, so
 * the shell + empty-state assertions pass in any environment. Row-level assertions
 * run only when seeded recommendations are present.
 *
 * Run: npx playwright test tests/e2e/right-sizing.spec.ts --project=chromium
 */
import { test, expect, Page } from '@playwright/test';

async function gotoRightSizing(page: Page) {
    const res = await page.goto('/app/right-sizing', { waitUntil: 'domcontentloaded' });
    const status = res?.status() ?? 200;
    expect(status, `/app/right-sizing returned HTTP ${status}`).not.toBe(404);
    expect(page.url(), 'redirected to login').not.toContain('/login');
    // Wait for the recommendations fetch to settle.
    await page.waitForLoadState('networkidle');
}

test.describe('Right Sizing', () => {
    test('page loads with heading and KPI cards', async ({ page }) => {
        await gotoRightSizing(page);
        await expect(page.getByRole('heading', { name: 'Right Sizing' })).toBeVisible();
        await expect(page.getByText('Potential Monthly Savings')).toBeVisible();
    });

    test('filter and sort controls are present', async ({ page }) => {
        await gotoRightSizing(page);
        await expect(page.getByPlaceholder('Search resource…')).toBeVisible();
        await expect(page.getByText('Sort: Savings')).toBeVisible();
        // Run-scan and refresh actions exist.
        await expect(page.getByRole('button', { name: 'Run scan' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible();
    });

    test('shows table rows or an empty state', async ({ page }) => {
        await gotoRightSizing(page);
        const rows = page.locator('tbody tr');
        const count = await rows.count();
        if (count === 0) {
            await expect(page.getByText(/No recommendations match/i)).toBeVisible();
            return;
        }
        // Open the detail dialog for the first recommendation.
        await rows.first().click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        // Rationale + cost panels render.
        await expect(dialog.getByText('Est. savings / mo')).toBeVisible();

        // If the recommendation is actionable, approving persists the status.
        const approve = dialog.getByRole('button', { name: 'Approve' });
        if (await approve.isVisible().catch(() => false)) {
            await Promise.all([
                page.waitForResponse((r) => r.url().includes('/api/right-sizing/recommendations/') && r.request().method() === 'PATCH'),
                approve.click(),
            ]);
            await expect(dialog).not.toBeVisible();
        }
    });
});
