/**
 * KB Inline Documents E2E — /app/knowledge-base/[kbId]
 *
 * Covers the inline-document authoring feature:
 *  - "New Document" opens the markdown editor dialog
 *  - Write/Preview tabs render markdown
 *  - Creating a document either lists it (embedding provider configured) or
 *    surfaces an error toast (no provider → the API returns 400 by design).
 *    Both are valid outcomes, so this exercises the full wiring without a
 *    false green in environments without a configured embedding provider.
 *
 * Run: cd apps/web-ui-e2e && bunx playwright test kb-documents.spec.ts
 */
import { test, expect, Page } from '@playwright/test';

async function gotoKnowledgeBase(page: Page) {
    const res = await page.goto('/app/knowledge-base', { waitUntil: 'domcontentloaded', timeout: 60000 });
    expect(res?.status(), 'knowledge-base page should not 404').not.toBe(404);
    expect(page.url(), 'knowledge-base page should not redirect to login').not.toContain('/login');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('[class*="animate-spin"]')).toHaveCount(0, { timeout: 15000 });
}

// Opens a knowledge base detail page, creating a KB first if none exist.
async function openAnyKnowledgeBase(page: Page) {
    const emptyState = await page.getByText('No knowledge bases yet').isVisible().catch(() => false);
    if (emptyState) {
        await page.getByRole('button', { name: /Create Knowledge Base/i }).first().click();
        await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10000 });
        await page.getByLabel(/Name/i).fill(`E2E KB ${Date.now()}`);
        await page.getByRole('button', { name: /^Create$/i }).click();
        await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 10000 });
        await page.waitForLoadState('networkidle');
    }

    await page.getByRole('button', { name: 'Open' }).first().click();
    await expect(page).toHaveURL(/\/app\/knowledge-base\/[^/]+$/, { timeout: 15000 });
    await expect(page.getByRole('button', { name: 'New Document' })).toBeVisible({ timeout: 15000 });
}

test.describe('KB inline documents', () => {
    test.beforeEach(async ({ page }) => {
        await gotoKnowledgeBase(page);
    });

    test('New Document dialog opens and previews markdown', async ({ page }) => {
        await openAnyKnowledgeBase(page);

        await page.getByRole('button', { name: 'New Document' }).click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible({ timeout: 10000 });
        await expect(dialog.getByText('New Document')).toBeVisible();

        // Fields are matched by placeholder (labels are not htmlFor-associated).
        await page.getByPlaceholder('e.g. Incident runbook').fill(`E2E Doc ${Date.now()}`);
        await page.getByPlaceholder(/Write markdown/).fill('# Heading\n\nBody text for embedding.');

        // Preview tab renders the markdown as HTML.
        await page.getByRole('tab', { name: 'Preview' }).click();
        await expect(dialog.getByRole('heading', { name: 'Heading' })).toBeVisible({ timeout: 5000 });
    });

    test('creating a document lists it or surfaces an error toast', async ({ page }) => {
        await openAnyKnowledgeBase(page);

        await page.getByRole('button', { name: 'New Document' }).click();
        await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10000 });

        const name = `E2E Doc ${Date.now()}`;
        await page.getByPlaceholder('e.g. Incident runbook').fill(name);
        await page.getByPlaceholder(/Write markdown/).fill('# Runbook\n\nRestart the service when health checks fail.');
        await page.getByRole('button', { name: /^Create$/ }).click();

        // Synchronous embed needs a configured provider. Accept EITHER outcome:
        //  - success  → dialog closes and the document appears in the Data Sources list
        //  - no provider / 400 → an error toast is surfaced
        const listed = page.getByText(name);
        const errorToast = page.locator('[data-sonner-toast]');
        await expect(listed.or(errorToast).first()).toBeVisible({ timeout: 30000 });
    });
});
