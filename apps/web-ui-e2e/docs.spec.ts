/**
 * Docs E2E tests — /docs/*
 * Covers the Fumadocs-powered documentation section.
 * All docs pages are public — no auth required.
 */
import { test, expect } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } }); // no auth needed

// ─── Helper ──────────────────────────────────────────────────────────────────

async function gotoDoc(page: any, path: string) {
    const res = await page.goto(path, { waitUntil: 'domcontentloaded' });
    expect(res?.status(), `${path} returned HTTP ${res?.status()}`).not.toBe(404);
}

// ─── Docs Root ───────────────────────────────────────────────────────────────

test.describe('Docs — Root (/docs)', () => {
    test.beforeEach(async ({ page }) => {
        await gotoDoc(page, '/docs');
    });

    test('page loads without 404', async ({ page }) => {
        const body = await page.locator('body').innerText();
        expect(body).not.toMatch(/404|This page could not be found/i);
    });

    test('docs title heading is visible', async ({ page }) => {
        await expect(
            page.getByRole('heading', { name: /Nucleus Ops Documentation/i })
        ).toBeVisible({ timeout: 10000 });
    });

    test('Features table is present', async ({ page }) => {
        // Scope to table cells to avoid matching parent containers in strict mode
        await expect(page.locator('table td', { hasText: 'Cost Scheduler' }).first()).toBeVisible();
        await expect(page.locator('table td', { hasText: 'AI Ops' }).first()).toBeVisible();
        await expect(page.locator('table td', { hasText: 'Knowledge Base' }).first()).toBeVisible();
    });

    test('Quick Links section is present', async ({ page }) => {
        // Heading text is "Quick Links Link to section" — use role + partial name
        await expect(page.getByRole('heading', { name: /Quick Links/ }).first()).toBeVisible();
        // Link appears in both sidebar and article — use first()
        await expect(page.getByRole('link', { name: 'Getting Started' }).first()).toBeVisible();
        await expect(page.getByRole('link', { name: 'Installation' }).first()).toBeVisible();
    });

    test('sidebar navigation is rendered', async ({ page }) => {
        // Fumadocs sidebar contains nav links
        await expect(page.getByRole('link', { name: /Getting Started/i }).first()).toBeVisible();
    });
});

// ─── Getting Started ─────────────────────────────────────────────────────────

test.describe('Docs — Getting Started (/docs/getting-started)', () => {
    test.beforeEach(async ({ page }) => {
        await gotoDoc(page, '/docs/getting-started');
    });

    test('page loads without 404', async ({ page }) => {
        const body = await page.locator('body').innerText();
        expect(body).not.toMatch(/404|This page could not be found/i);
    });

    test('Getting Started heading is visible', async ({ page }) => {
        await expect(
            page.getByRole('heading', { name: /Getting Started/i })
        ).toBeVisible({ timeout: 10000 });
    });

    test('Step 1: Sign In section is present', async ({ page }) => {
        await expect(page.getByRole('heading', { name: /Step 1/i })).toBeVisible();
    });

    test('Step 2: Connect an AWS Account section is present', async ({ page }) => {
        await expect(page.getByRole('heading', { name: /Step 2/i })).toBeVisible();
    });

    test('Prerequisites section is present', async ({ page }) => {
        await expect(page.getByRole('heading', { name: /Prerequisites/i })).toBeVisible();
    });

    test('Next Steps section links to /docs/configuration', async ({ page }) => {
        await expect(page.getByRole('link', { name: /Configure multiple accounts/i })).toBeVisible();
    });
});

// ─── Installation ─────────────────────────────────────────────────────────────

test.describe('Docs — Installation (/docs/installation)', () => {
    test.beforeEach(async ({ page }) => {
        await gotoDoc(page, '/docs/installation');
    });

    test('page loads without 404', async ({ page }) => {
        const body = await page.locator('body').innerText();
        expect(body).not.toMatch(/404|This page could not be found/i);
    });

    test('Installation heading is visible', async ({ page }) => {
        await expect(
            page.getByRole('heading', { name: /Installation/i })
        ).toBeVisible({ timeout: 10000 });
    });
});

// ─── Configuration ───────────────────────────────────────────────────────────

test.describe('Docs — Configuration (/docs/configuration)', () => {
    test.beforeEach(async ({ page }) => {
        await gotoDoc(page, '/docs/configuration');
    });

    test('page loads without 404', async ({ page }) => {
        const body = await page.locator('body').innerText();
        expect(body).not.toMatch(/404|This page could not be found/i);
    });

    test('Configuration heading is visible', async ({ page }) => {
        // Use exact match to avoid matching "Bedrock Configuration" heading on same page
        await expect(
            page.getByRole('heading', { name: 'Configuration', exact: true })
        ).toBeVisible({ timeout: 10000 });
    });
});

// ─── Tutorials ───────────────────────────────────────────────────────────────

test.describe('Docs — Tutorials (/docs/tutorials)', () => {
    test.beforeEach(async ({ page }) => {
        await gotoDoc(page, '/docs/tutorials');
    });

    test('page loads without 404', async ({ page }) => {
        const body = await page.locator('body').innerText();
        expect(body).not.toMatch(/404|This page could not be found/i);
    });

    test('Tutorials heading is visible', async ({ page }) => {
        await expect(
            page.getByRole('heading', { name: /Tutorials/i })
        ).toBeVisible({ timeout: 10000 });
    });
});

// ─── FAQ ─────────────────────────────────────────────────────────────────────

test.describe('Docs — FAQ (/docs/faq)', () => {
    test.beforeEach(async ({ page }) => {
        await gotoDoc(page, '/docs/faq');
    });

    test('page loads without 404', async ({ page }) => {
        const body = await page.locator('body').innerText();
        expect(body).not.toMatch(/404|This page could not be found/i);
    });

    test('FAQ heading is visible', async ({ page }) => {
        await expect(
            page.getByRole('heading', { name: /FAQ/i })
        ).toBeVisible({ timeout: 10000 });
    });
});

// ─── Docs Sidebar Navigation ──────────────────────────────────────────────────

test.describe('Docs — Sidebar Links', () => {
    test('all sidebar doc links load without 404', async ({ page }) => {
        await gotoDoc(page, '/docs');

        const docLinks = [
            '/docs/getting-started',
            '/docs/installation',
            '/docs/configuration',
            '/docs/tutorials',
            '/docs/faq',
        ];

        for (const link of docLinks) {
            const res = await page.goto(link, { waitUntil: 'domcontentloaded' });
            const status = res?.status() ?? 200;
            expect(status, `${link} returned HTTP ${status}`).not.toBe(404);
            const body = await page.locator('body').innerText();
            expect(body, `${link} shows 404 page`).not.toMatch(/This page could not be found/i);
        }
    });
});
