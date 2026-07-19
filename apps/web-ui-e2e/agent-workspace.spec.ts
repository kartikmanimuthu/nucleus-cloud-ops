/**
 * AI Ops Workspace E2E smoke — /app/agent
 *
 * Verifies the redesigned workspace shell renders: session sidebar, composer,
 * and the run rail (on lg viewports). These are static-structure assertions
 * that do NOT require a live model backend, so they run in any environment
 * where the app boots and the user is authenticated.
 *
 * The message-send / streaming / plan-rail behaviors live in
 * agent-mission-control.spec.ts, gated behind E2E_LIVE_AGENT.
 *
 * Run: cd apps/web-ui-e2e && bunx playwright test agent-workspace.spec.ts
 */
import { test, expect, Page } from '@playwright/test';

async function gotoWorkspace(page: Page) {
  const res = await page.goto('/app/agent', { waitUntil: 'domcontentloaded', timeout: 60000 });
  expect(res?.status(), 'agent page should not 404').not.toBe(404);
  const body = await page.locator('body').innerText().catch(() => '');
  expect(body, 'agent page should not show 404 message').not.toMatch(/This page could not be found/i);
  expect(page.url(), 'agent page should not redirect to login').not.toContain('/login');
}

test.describe('AI Ops Workspace — shell', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoWorkspace(page);
  });

  test('renders the composer input', async ({ page }) => {
    await expect(page.getByTestId('composer-input')).toBeVisible({ timeout: 15000 });
  });

  test('renders a "New chat" control in the session sidebar', async ({ page }) => {
    await expect(page.getByRole('button', { name: /new chat/i }).first()).toBeVisible({ timeout: 10000 });
  });

  test('shows the session search box', async ({ page }) => {
    await expect(page.getByPlaceholder(/search sessions/i)).toBeVisible({ timeout: 10000 });
  });

  test('mounts an active session view', async ({ page }) => {
    await expect(page.getByTestId('session-view')).toBeVisible({ timeout: 10000 });
  });

  test('run rail region is present on lg viewports', async ({ page }) => {
    await expect(page.getByTestId('run-rail')).toBeVisible({ timeout: 10000 });
  });
});

test.describe('AI Ops Workspace — responsive', () => {
  test('run rail hides and a mobile menu appears below lg', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await gotoWorkspace(page);
    await expect(page.getByTestId('run-rail')).toBeHidden();
    await expect(page.getByRole('button', { name: /open sessions/i })).toBeVisible({ timeout: 10000 });
  });
});

test.describe('AI Ops Workspace — composer', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoWorkspace(page);
    await expect(page.getByTestId('composer-input')).toBeVisible({ timeout: 15000 });
  });

  test('send button is disabled while the input is empty', async ({ page }) => {
    await expect(page.getByTestId('composer-send-button')).toBeDisabled({ timeout: 5000 });
  });

  test('send button enables once the input has text', async ({ page }) => {
    await page.getByTestId('composer-input').fill('test');
    await expect(page.getByTestId('composer-send-button')).toBeEnabled({ timeout: 5000 });
  });
});

// ── Live agent interactions ──────────────────────────────────────────────────
// These drive a real model response and are gated behind E2E_LIVE_AGENT since
// no model provider is configured in most environments (local dev / CI here).
test.describe('AI Ops Workspace — live agent', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoWorkspace(page);
    await expect(page.getByTestId('composer-input')).toBeVisible({ timeout: 15000 });
  });

  test('a sent message appears as a user bubble', async ({ page }) => {
    test.skip(!process.env.E2E_LIVE_AGENT, 'requires a configured model provider');
    await page.getByTestId('composer-input').fill('Hello, this is a test message');
    await page.getByTestId('composer-send-button').click();
    await expect(page.getByTestId('user-bubble').first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('user-bubble').first()).toContainText('Hello, this is a test message');
  });

  test('a mutative request pauses at the approval card', async ({ page }) => {
    test.skip(!process.env.E2E_LIVE_AGENT, 'requires a configured model provider');
    await page.getByTestId('composer-input').fill(
      'Execute exactly this command with execute_command and nothing else: aws ec2 stop-instances --instance-ids i-00000000000000000 --region us-east-1',
    );
    await page.getByTestId('composer-send-button').click();
    const card = page.getByTestId('approval-batch-card');
    await expect(card).toBeVisible({ timeout: 120_000 });
    // Reject so the E2E run never mutates anything.
    await card.getByRole('button', { name: /reject/i }).first().click();
  });
});
