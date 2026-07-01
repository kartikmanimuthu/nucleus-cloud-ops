/**
 * Skills module E2E tests — /app/skills
 *
 * Covers:
 *  - Page load: heading and "Create skill" button visible
 *  - Create a skill: open dialog → fill fields → submit → skill appears in list
 *  - AI Ops integration: newly created skill appears in the skill selector dropdown
 *
 * Requires: dev server running (bun run dev on port 3001).
 * Run: cd apps/web-ui-e2e && bunx playwright test skills.spec.ts
 */
import { test, expect, Page } from '@playwright/test';

// ─── Helper ──────────────────────────────────────────────────────────────────

async function gotoSkills(page: Page) {
    const res = await page.goto('/app/skills', { waitUntil: 'domcontentloaded', timeout: 60000 });
    expect(res?.status(), 'skills page should not 404').not.toBe(404);
    const body = await page.locator('body').innerText().catch(() => '');
    expect(body, 'skills page should not show 404 message').not.toMatch(/This page could not be found/i);
    expect(page.url(), 'skills page should not redirect to login').not.toContain('/login');
}

// ─── Page Load ────────────────────────────────────────────────────────────────

test.describe('Skills — Page Load', () => {
    test.beforeEach(async ({ page }) => {
        await gotoSkills(page);
    });

    test('Skills heading is visible', async ({ page }) => {
        await expect(
            page.getByRole('heading', { name: 'Skills' })
        ).toBeVisible({ timeout: 15000 });
    });

    test('"Create skill" button is visible', async ({ page }) => {
        await expect(
            page.getByRole('button', { name: 'Create skill' })
        ).toBeVisible({ timeout: 10000 });
    });
});

// ─── Create skill ─────────────────────────────────────────────────────────────

test.describe('Skills — Create', () => {
    test('create a skill and see it in the list', async ({ page }) => {
        // Use a fixed suffix so tests are deterministic and unique per run
        const skillName = `E2E Cost Skill ${Date.now()}`;

        await gotoSkills(page);

        // Click the page-level "Create skill" button (outside any dialog)
        await page.getByRole('button', { name: 'Create skill' }).click();

        // Dialog should appear
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible({ timeout: 10000 });

        // Fill Name (FormLabel "Name" → htmlFor wired by React Hook Form)
        await page.getByLabel('Name').fill(skillName);

        // Fill Description (FormLabel "Description")
        await page.getByLabel('Description').fill('E2E created skill for cost analysis');

        // Monaco editor: click the editor region and type content.
        // The Monaco container is a div with class "monaco-editor"; it is not a textarea.
        const monacoEditor = dialog.locator('.monaco-editor').first();
        await expect(monacoEditor).toBeVisible({ timeout: 15000 });
        await monacoEditor.click();
        await page.keyboard.type('# E2E Skill\n1. Do the thing.');

        // Submit the form — scope to the dialog to avoid matching the page-level button
        await dialog.getByRole('button', { name: 'Create skill' }).click();

        // Dialog should close
        await expect(dialog).not.toBeVisible({ timeout: 10000 });

        // Skill should appear in the list
        await expect(page.getByText(skillName)).toBeVisible({ timeout: 10000 });
    });
});

// ─── AI Ops integration ────────────────────────────────────────────────────────

test.describe('Skills — AI Ops Integration', () => {
    test('created skill appears in the AI Ops skill selector', async ({ page }) => {
        const skillName = `E2E Ops Skill ${Date.now()}`;

        // Step 1: Create the skill via the Skills console
        await gotoSkills(page);
        await page.getByRole('button', { name: 'Create skill' }).click();

        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible({ timeout: 10000 });

        await page.getByLabel('Name').fill(skillName);
        await page.getByLabel('Description').fill('E2E skill for AI Ops integration test');

        const monacoEditor = dialog.locator('.monaco-editor').first();
        await expect(monacoEditor).toBeVisible({ timeout: 15000 });
        await monacoEditor.click();
        await page.keyboard.type('# Ops Skill\n- Step 1\n- Step 2');

        // Scoped submit: dialog's "Create skill" button (not the page-level one)
        await dialog.getByRole('button', { name: 'Create skill' }).click();
        await expect(dialog).not.toBeVisible({ timeout: 10000 });
        await expect(page.getByText(skillName)).toBeVisible({ timeout: 10000 });

        // Step 2: Navigate to AI Ops and verify the skill appears in the selector
        const agentRes = await page.goto('/app/agent', { waitUntil: 'domcontentloaded', timeout: 60000 });
        expect(agentRes?.status(), 'agent page should not 404').not.toBe(404);
        expect(page.url(), 'agent page should not redirect to login').not.toContain('/login');

        // Wait for the skills fetch to resolve so the newly created skill is in the dropdown
        await page.waitForResponse((r) => r.url().includes('/api/skills') && r.status() === 200);

        // The skill selector trigger shows "Select Agent Skill" when nothing is chosen.
        // It renders as a Radix Select whose trigger contains that exact text.
        await expect(
            page.getByText('Select Agent Skill')
        ).toBeVisible({ timeout: 15000 });

        // Open the skill selector
        await page.getByText('Select Agent Skill').click();

        // The newly created skill should appear as an option
        await expect(
            page.getByText(skillName)
        ).toBeVisible({ timeout: 10000 });
    });
});
