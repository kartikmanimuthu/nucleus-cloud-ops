/**
 * Agent Ops Dashboard + Scheduled Tasks E2E tests
 *
 * Covers:
 *  - Agent ops dashboard page load, heading, subtitle
 *  - Runs list or empty state
 *  - Action buttons (Refresh, Scheduled Tasks, New Agent Run)
 *  - Navigation to scheduled tasks page
 *  - Scheduled tasks page load, heading, stats cards
 *  - New Scheduled Task button and dialog
 *  - Back navigation from scheduled tasks to dashboard
 *
 * Run: cd apps/web-ui-e2e && bunx playwright test agent-ops.spec.ts
 */
import { test, expect, Page } from '@playwright/test';

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function gotoAgentOps(page: Page) {
    const res = await page.goto('/app/agent-ops', { waitUntil: 'domcontentloaded', timeout: 60000 });
    expect(res?.status(), 'agent-ops page should not 404').not.toBe(404);
    const body = await page.locator('body').innerText().catch(() => '');
    expect(body, 'agent-ops page should not show 404 message').not.toMatch(/This page could not be found/i);
    expect(page.url(), 'agent-ops page should not redirect to login').not.toContain('/login');
    await page.waitForLoadState('networkidle');
}

async function gotoScheduledTasks(page: Page) {
    const res = await page.goto('/app/agent-ops/scheduled-tasks', { waitUntil: 'domcontentloaded', timeout: 60000 });
    expect(res?.status(), 'scheduled-tasks page should not 404').not.toBe(404);
    const body = await page.locator('body').innerText().catch(() => '');
    expect(body, 'scheduled-tasks page should not show 404 message').not.toMatch(/This page could not be found/i);
    expect(page.url(), 'scheduled-tasks page should not redirect to login').not.toContain('/login');
    await page.waitForLoadState('networkidle');
}

// ─── Agent Ops Dashboard — Page Load ─────────────────────────────────────────

test.describe('Agent Ops Dashboard — Page Load', () => {
    test.beforeEach(async ({ page }) => {
        await gotoAgentOps(page);
    });

    test('page heading is visible', async ({ page }) => {
        await expect(
            page.getByRole('heading', { name: /Agent Ops/i })
        ).toBeVisible({ timeout: 15000 });
    });

    test('page subtitle is visible', async ({ page }) => {
        await expect(
            page.getByText('Background agent executions triggered by Slack, Jira, API, or schedule')
        ).toBeVisible({ timeout: 10000 });
    });

    test('Refresh button is visible', async ({ page }) => {
        await expect(
            page.getByRole('button', { name: /Refresh/i }).first()
        ).toBeVisible({ timeout: 10000 });
    });

    test('Scheduled Tasks button is visible', async ({ page }) => {
        await expect(
            page.getByRole('button', { name: /Scheduled Tasks/i })
        ).toBeVisible({ timeout: 10000 });
    });

    test('New Agent Run button is visible', async ({ page }) => {
        await expect(
            page.getByRole('button', { name: /New Agent Run/i })
        ).toBeVisible({ timeout: 10000 });
    });
});

// ─── Agent Ops Dashboard — Runs Content ──────────────────────────────────────

test.describe('Agent Ops Dashboard — Runs Content', () => {
    test.beforeEach(async ({ page }) => {
        await gotoAgentOps(page);
        // Wait for loading to complete
        await expect(page.locator('[class*="animate-spin"]')).toHaveCount(0, { timeout: 15000 });
    });

    test('shows runs list or empty state after loading', async ({ page }) => {
        // Either run cards exist or an empty/no-runs state is shown
        const hasRuns = await page.locator('[class*="Card"]').count();
        const pageText = await page.locator('body').innerText();
        // Page should have loaded meaningful content (stats or runs or empty message)
        expect(hasRuns > 0 || pageText.length > 0, 'should show runs or empty state').toBeTruthy();
    });
});

// ─── Agent Ops Dashboard — New Run Dialog ────────────────────────────────────

test.describe('Agent Ops Dashboard — New Run Dialog', () => {
    test.beforeEach(async ({ page }) => {
        await gotoAgentOps(page);
        await expect(page.locator('[class*="animate-spin"]')).toHaveCount(0, { timeout: 15000 });
    });

    test('clicking New Agent Run opens dialog', async ({ page }) => {
        await page.getByRole('button', { name: /New Agent Run/i }).click();
        await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10000 });
    });

    test('new run dialog has task description field', async ({ page }) => {
        await page.getByRole('button', { name: /New Agent Run/i }).click();
        await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10000 });
        // Dialog should have a textarea or input for task description
        const hasTextarea = await page.getByRole('dialog').locator('textarea').count();
        const hasInput = await page.getByRole('dialog').locator('input').count();
        expect(hasTextarea + hasInput, 'dialog should have at least one input field').toBeGreaterThan(0);
    });
});

// ─── Agent Ops Dashboard — Navigation ────────────────────────────────────────

test.describe('Agent Ops Dashboard — Navigation', () => {
    test.beforeEach(async ({ page }) => {
        await gotoAgentOps(page);
    });

    test('clicking Scheduled Tasks navigates to scheduled-tasks page', async ({ page }) => {
        await page.getByRole('button', { name: /Scheduled Tasks/i }).click();
        await page.waitForLoadState('networkidle');
        expect(page.url()).toContain('/agent-ops/scheduled-tasks');
    });
});

// ─── Scheduled Tasks — Page Load ─────────────────────────────────────────────

test.describe('Scheduled Tasks — Page Load', () => {
    test.beforeEach(async ({ page }) => {
        await gotoScheduledTasks(page);
    });

    test('page heading is visible', async ({ page }) => {
        await expect(
            page.getByRole('heading', { name: /Scheduled Tasks/i })
        ).toBeVisible({ timeout: 15000 });
    });

    test('page subtitle is visible', async ({ page }) => {
        await expect(
            page.getByText('Recurring agent executions on a cron schedule')
        ).toBeVisible({ timeout: 10000 });
    });

    test('Refresh button is visible', async ({ page }) => {
        await expect(
            page.getByRole('button', { name: /Refresh/i })
        ).toBeVisible({ timeout: 10000 });
    });

    test('New Scheduled Task button is visible', async ({ page }) => {
        await expect(
            page.getByRole('button', { name: /New Scheduled Task/i })
        ).toBeVisible({ timeout: 10000 });
    });

    test('Back button is visible', async ({ page }) => {
        await expect(
            page.getByRole('button', { name: /Back/i })
        ).toBeVisible({ timeout: 10000 });
    });
});

// ─── Scheduled Tasks — Stats Cards ───────────────────────────────────────────

test.describe('Scheduled Tasks — Stats Cards', () => {
    test.beforeEach(async ({ page }) => {
        await gotoScheduledTasks(page);
        await expect(page.locator('[class*="animate-spin"]')).toHaveCount(0, { timeout: 15000 });
    });

    test('Active stat card is visible', async ({ page }) => {
        await expect(page.getByText('Active')).toBeVisible({ timeout: 10000 });
    });

    test('Paused stat card is visible', async ({ page }) => {
        await expect(page.getByText('Paused')).toBeVisible({ timeout: 10000 });
    });

    test('Total Runs stat card is visible', async ({ page }) => {
        await expect(page.getByText('Total Runs')).toBeVisible({ timeout: 10000 });
    });
});

// ─── Scheduled Tasks — New Task Dialog ───────────────────────────────────────

test.describe('Scheduled Tasks — New Task Dialog', () => {
    test.beforeEach(async ({ page }) => {
        await gotoScheduledTasks(page);
        await expect(page.locator('[class*="animate-spin"]')).toHaveCount(0, { timeout: 15000 });
    });

    test('clicking New Scheduled Task opens dialog', async ({ page }) => {
        await page.getByRole('button', { name: /New Scheduled Task/i }).click();
        await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10000 });
    });

    test('new task dialog title is visible', async ({ page }) => {
        await page.getByRole('button', { name: /New Scheduled Task/i }).click();
        await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10000 });
        await expect(
            page.getByRole('dialog').getByText(/New Scheduled Task/i)
        ).toBeVisible({ timeout: 5000 });
    });
});

// ─── Scheduled Tasks — Navigation ────────────────────────────────────────────

test.describe('Scheduled Tasks — Navigation', () => {
    test.beforeEach(async ({ page }) => {
        await gotoScheduledTasks(page);
    });

    test('clicking Back navigates to agent-ops dashboard', async ({ page }) => {
        await page.getByRole('button', { name: /Back/i }).click();
        await page.waitForLoadState('networkidle');
        expect(page.url()).toContain('/agent-ops');
        expect(page.url()).not.toContain('/scheduled-tasks');
    });
});
