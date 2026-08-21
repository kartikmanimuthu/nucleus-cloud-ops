/**
 * Spot Guard E2E tests — /app/cost-optimization/spot-guard (SG-014)
 *
 * The page route renders regardless of whether SPOT_GUARD_ENABLED is set on the workers
 * side (that flag gates the background jobs, not the UI), and every API returns an empty
 * list when nothing is onboarded — so the shell, KPI and empty-state assertions pass in any
 * environment. Row-level assertions run only when seeded data is present.
 *
 * The one behaviour genuinely worth an E2E is the CONFIRMATION GATE on Enable Spot: it is
 * the only thing between a stray click and a rolling ECS deployment that moves production
 * traffic onto interruptible capacity. Unit tests cover the API's own check; this proves the
 * UI does not let a user past it either.
 *
 * Run: cd apps/web-ui-e2e && npx playwright test spot-guard.spec.ts --project=chromium
 */
import { test, expect, Page } from '@playwright/test';

async function gotoSpotGuard(page: Page, tab?: 'managed' | 'eligible') {
    const url = tab ? `/app/cost-optimization/spot-guard?tab=${tab}` : '/app/cost-optimization/spot-guard';
    const res = await page.goto(url, { waitUntil: 'domcontentloaded' });
    const status = res?.status() ?? 200;
    expect(status, `${url} returned HTTP ${status}`).not.toBe(404);
    expect(page.url(), 'redirected to login').not.toContain('/login');
    await page.waitForLoadState('networkidle');
}

test.describe('Spot Guard', () => {
    test('page loads with heading and KPI cards', async ({ page }) => {
        await gotoSpotGuard(page);
        await expect(page.getByRole('heading', { name: 'Spot Guard' })).toBeVisible();
        await expect(page.getByText('Services on Spot')).toBeVisible();
        await expect(page.getByText('In Fallback')).toBeVisible();
        await expect(page.getByText('Interruptions (24h)')).toBeVisible();
    });

    test('managed and eligible tabs are present and switchable', async ({ page }) => {
        await gotoSpotGuard(page);
        const managed = page.getByRole('tab', { name: 'Managed' });
        const eligible = page.getByRole('tab', { name: 'Eligible' });
        await expect(managed).toBeVisible();
        await expect(eligible).toBeVisible();

        await eligible.click();
        await expect(eligible).toHaveAttribute('data-state', 'active');
    });

    test('search control is present', async ({ page }) => {
        await gotoSpotGuard(page);
        await expect(page.getByRole('textbox', { name: 'Search services' })).toBeVisible();
    });

    test('Restore now never opens a confirmation dialog', async ({ page }) => {
        // REGRESSION: onRestore used to borrow the `action` state to mark the row busy, and
        // ConfirmServiceDialog is mounted whenever action !== null with `open` hard-set. So every
        // Restore-now click flashed the Disable-Spot dialog — inputs and all — open for the
        // duration of the POST and then tore it down. It read as "the popover closes instantly".
        //
        // Restore is the one action with NO confirmation step (it cannot force an unsafe change;
        // the worker's safety gates all still apply), so a dialog must never appear.
        await gotoSpotGuard(page, 'managed');
        const restore = page.getByRole('button', { name: /restore now/i }).first();
        if (!(await restore.count())) test.skip(true, 'no managed services in this environment');

        // Sample DURING the request, not after: the flash only lasted as long as the POST, so
        // checking once at the end would miss it.
        let dialogSeen = false;
        const poll = setInterval(() => {
            page.locator('[role=dialog]')
                .count()
                .then((n) => { if (n > 0) dialogSeen = true; })
                .catch(() => {});
        }, 40);
        await restore.click();
        await page.waitForTimeout(1800);
        clearInterval(poll);

        expect(dialogSeen, 'a confirmation dialog appeared during Restore now').toBe(false);
    });

    test('managed tab shows either rows or an empty state', async ({ page }) => {
        await gotoSpotGuard(page, 'managed');
        // Either outcome is valid depending on environment; what must NOT happen is a blank
        // panel with neither.
        const emptyState = page.getByText('No services under Spot Guard yet');
        const table = page.getByRole('table');
        await expect(emptyState.or(table).first()).toBeVisible();
    });

    test('eligible tab shows either rows or an empty state', async ({ page }) => {
        await gotoSpotGuard(page, 'eligible');
        const emptyState = page.getByText('No ECS services discovered yet');
        const table = page.getByRole('table');
        await expect(emptyState.or(table).first()).toBeVisible();
    });

    test('Enable Spot stays disabled until the service name is typed exactly', async ({ page }) => {
        await gotoSpotGuard(page, 'eligible');

        const enableButtons = page.getByRole('button', { name: 'Enable Spot' });
        const count = await enableButtons.count();
        test.skip(count === 0, 'No eligible ECS services in this environment to enable');

        // Find the first ENABLED button — rows classified needs_capacity_providers are
        // deliberately disabled and cannot open the dialog.
        let opened = false;
        for (let i = 0; i < count; i++) {
            const button = enableButtons.nth(i);
            if (await button.isEnabled()) {
                await button.click();
                opened = true;
                break;
            }
        }
        test.skip(!opened, 'All eligible services are blocked (needs capacity providers)');

        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole('heading', { name: 'Enable Fargate Spot' })).toBeVisible();

        // The submit button inside the dialog, not the row buttons behind it.
        const submit = dialog.getByRole('button', { name: 'Enable Spot' });
        await expect(submit, 'submit must start disabled with an empty confirmation').toBeDisabled();

        // A near-miss must not unlock it — this is the whole point of typing the name.
        const confirmInput = dialog.getByRole('textbox').last();
        await confirmInput.fill('definitely-not-the-service-name');
        await expect(submit, 'a wrong name must not unlock submit').toBeDisabled();

        // The dialog states the required name in its label placeholder, so read it back.
        const required = await confirmInput.getAttribute('placeholder');
        expect(required, 'dialog must tell the user which name to type').toBeTruthy();
        await confirmInput.fill(required!);
        await expect(submit, 'the exact name must unlock submit').toBeEnabled();

        // Do NOT submit: that would call ecs:UpdateService against a real AWS account and
        // bounce every task in the service. Verifying the gate is the objective.
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(dialog).not.toBeVisible();
    });

    test('Spot Guard appears in the Cost Optimization nav group', async ({ page }) => {
        await gotoSpotGuard(page);
        await expect(page.getByRole('link', { name: 'Spot Guard' })).toBeVisible();
    });
});
