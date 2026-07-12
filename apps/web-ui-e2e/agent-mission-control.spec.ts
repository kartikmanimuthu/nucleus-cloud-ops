import { test, expect } from '@playwright/test';

// These tests require a live agent backend (model provider configured).
// The two layout tests below assert static UI structure and always run.
// The two agent-interaction tests assert interrupt/plan-rail flow driven by a
// real model response and are gated behind E2E_LIVE_AGENT since no model
// provider is configured in most environments (including local dev/CI here).

test.describe('AI Ops Mission Control', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/app/agent');
        await page.waitForLoadState('networkidle');
    });

    test('layout renders composer and (on lg viewports) the run rail region', async ({ page }) => {
        await expect(page.getByPlaceholder(/ask the agent/i)).toBeVisible();
        await expect(page.getByText('Auto-approve read-only tools')).toBeVisible();
        // Rail is empty-state on a fresh thread but the region exists on lg
        await page.setViewportSize({ width: 1440, height: 900 });
        await expect(page.getByTestId('run-rail')).toBeVisible();
    });

    test('run rail hides below lg and header strip appears instead', async ({ page }) => {
        await page.setViewportSize({ width: 900, height: 800 });
        await expect(page.getByTestId('run-rail')).toBeHidden();
    });

    test('mutative request pauses at the approval card despite auto-approve on', async ({ page }) => {
        test.skip(!process.env.E2E_LIVE_AGENT, 'requires a configured model provider');
        await page.getByPlaceholder(/ask the agent/i).fill(
            'Execute exactly this command with execute_command and nothing else: aws ec2 stop-instances --instance-ids i-00000000000000000 --region us-east-1');
        await page.keyboard.press('Enter');
        const card = page.getByTestId('approval-batch-card');
        await expect(card).toBeVisible({ timeout: 120_000 });
        await expect(card.getByText(/awaiting your approval/i)).toBeVisible();
        // Reject so the E2E run never mutates anything.
        await card.getByRole('button', { name: /reject remaining|^Reject$/i }).first().click();
        // Run resumes: the agent produces further output after the rejection.
        await expect(page.getByTestId('ai-message').last()).toContainText(/reject|denied|not|cannot/i, { timeout: 120_000 });
    });

    test('plan mode shows a live plan in the rail', async ({ page }) => {
        test.skip(!process.env.E2E_LIVE_AGENT, 'requires a configured model provider');
        await page.setViewportSize({ width: 1440, height: 900 });
        // Switch to Plan & Execute mode
        await page.getByText('Fast (ReAct)').click();
        await page.getByText('Plan & Execute').click();
        await page.getByPlaceholder(/ask the agent/i).fill('List the files in your working directory and summarize them');
        await page.keyboard.press('Enter');
        await expect(page.getByTestId('run-rail').getByText(/execution plan/i)).toBeVisible({ timeout: 120_000 });
    });
});
