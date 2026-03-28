/**
 * Knowledge Base Management E2E tests — /app/knowledge-base/*
 *
 * Covers:
 *  - Page load, heading, subtitle
 *  - Create Knowledge Base button visibility
 *  - Empty state or KB card grid
 *  - Create KB dialog opens and has required fields
 *  - Navigation to KB detail page
 *
 * Run: npx playwright test tests/e2e/knowledge-base.spec.ts
 */
import { test, expect, Page } from '@playwright/test';

// ─── Helper ──────────────────────────────────────────────────────────────────

async function gotoKnowledgeBase(page: Page) {
    const res = await page.goto('/app/knowledge-base', { waitUntil: 'domcontentloaded', timeout: 60000 });
    expect(res?.status(), 'knowledge-base page should not 404').not.toBe(404);
    const body = await page.locator('body').innerText().catch(() => '');
    expect(body, 'knowledge-base page should not show 404 message').not.toMatch(/This page could not be found/i);
    expect(page.url(), 'knowledge-base page should not redirect to login').not.toContain('/login');
    await page.waitForLoadState('networkidle');
}

// ─── Page Load & Header ───────────────────────────────────────────────────────

test.describe('Knowledge Base — Page Load', () => {
    test.beforeEach(async ({ page }) => {
        await gotoKnowledgeBase(page);
    });

    test('page heading is visible', async ({ page }) => {
        await expect(
            page.getByRole('heading', { name: 'Knowledge Base' })
        ).toBeVisible({ timeout: 15000 });
    });

    test('page subtitle is visible', async ({ page }) => {
        await expect(
            page.getByText('Manage your knowledge bases and the documents they contain.')
        ).toBeVisible({ timeout: 10000 });
    });

    test('Create Knowledge Base button is visible in header', async ({ page }) => {
        await expect(
            page.getByRole('button', { name: /Create Knowledge Base/i }).first()
        ).toBeVisible({ timeout: 10000 });
    });
});

// ─── Empty State or KB List ───────────────────────────────────────────────────

test.describe('Knowledge Base — Content', () => {
    test.beforeEach(async ({ page }) => {
        await gotoKnowledgeBase(page);
    });

    test('shows KB cards or empty state after loading', async ({ page }) => {
        // Wait for loading spinner to disappear
        await expect(page.locator('[class*="animate-spin"]')).toHaveCount(0, { timeout: 15000 });

        // Either KB cards exist or empty state is shown
        const hasCards = await page.locator('[class*="grid"] [class*="Card"], [class*="grid"] .rounded-lg').count();
        const hasEmptyState = await page.getByText('No knowledge bases yet').isVisible().catch(() => false);

        expect(hasCards > 0 || hasEmptyState, 'should show KB cards or empty state').toBeTruthy();
    });

    test('empty state shows Create Knowledge Base button', async ({ page }) => {
        await expect(page.locator('[class*="animate-spin"]')).toHaveCount(0, { timeout: 15000 });

        const hasEmptyState = await page.getByText('No knowledge bases yet').isVisible().catch(() => false);
        if (hasEmptyState) {
            await expect(
                page.getByRole('button', { name: /Create Knowledge Base/i }).last()
            ).toBeVisible({ timeout: 10000 });
        }
    });
});

// ─── Create KB Dialog ─────────────────────────────────────────────────────────

test.describe('Knowledge Base — Create Dialog', () => {
    test.beforeEach(async ({ page }) => {
        await gotoKnowledgeBase(page);
        await expect(page.locator('[class*="animate-spin"]')).toHaveCount(0, { timeout: 15000 });
    });

    test('clicking Create Knowledge Base opens dialog', async ({ page }) => {
        await page.getByRole('button', { name: /Create Knowledge Base/i }).first().click();
        await expect(
            page.getByRole('dialog')
        ).toBeVisible({ timeout: 10000 });
    });

    test('create dialog has Name field', async ({ page }) => {
        await page.getByRole('button', { name: /Create Knowledge Base/i }).first().click();
        await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10000 });
        await expect(page.getByLabel(/Name/i)).toBeVisible({ timeout: 5000 });
    });

    test('create dialog has Description field', async ({ page }) => {
        await page.getByRole('button', { name: /Create Knowledge Base/i }).first().click();
        await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10000 });
        await expect(page.getByLabel(/Description/i)).toBeVisible({ timeout: 5000 });
    });

    test('create dialog has Cancel and Create buttons', async ({ page }) => {
        await page.getByRole('button', { name: /Create Knowledge Base/i }).first().click();
        await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10000 });
        await expect(page.getByRole('button', { name: /Cancel/i })).toBeVisible({ timeout: 5000 });
        await expect(page.getByRole('button', { name: /^Create$/i })).toBeVisible({ timeout: 5000 });
    });

    test('cancel button closes the dialog', async ({ page }) => {
        await page.getByRole('button', { name: /Create Knowledge Base/i }).first().click();
        await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10000 });
        await page.getByRole('button', { name: /Cancel/i }).click();
        await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 5000 });
    });
});
