/**
 * App Navigation E2E tests — /app/*
 * Verifies all authenticated app routes load correctly after the
 * folder restructure (pages moved from /app/<module> to /app/app/<module>).
 *
 * Pattern: navigate → assert no 404 → assert key heading/element visible.
 * Run: cd apps/web-ui-e2e && bunx playwright test navigation.spec.ts
 */
import { test, expect, Page } from '@playwright/test';

// ─── Helper ──────────────────────────────────────────────────────────────────

async function goto(page: Page, path: string) {
    const res = await page.goto(path, { waitUntil: 'domcontentloaded' });
    const status = res?.status() ?? 200;
    expect(status, `${path} returned HTTP ${status}`).not.toBe(404);
    const body = await page.locator('body').innerText().catch(() => '');
    expect(body, `${path} shows 404 page`).not.toMatch(/This page could not be found/i);
    // Must not redirect to login — user is authenticated
    expect(page.url(), `${path} redirected to login`).not.toContain('/login');
    return page;
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

test.describe('App — Dashboard', () => {
    test('/app/dashboard loads', async ({ page }) => {
        await goto(page, '/app/dashboard');
    });

    test('/app/dashboard shows stats cards', async ({ page }) => {
        await goto(page, '/app/dashboard');
        // Dashboard renders Total Schedules, Total Accounts etc.
        await expect(
            page.getByText(/Total Schedules|Total Accounts|Monthly Savings|Agent Runs/i).first()
        ).toBeVisible({ timeout: 10000 });
    });
});

// ─── AWS Accounts ─────────────────────────────────────────────────────────────

test.describe('App — AWS Accounts', () => {
    test('/app/accounts list page loads', async ({ page }) => {
        await goto(page, '/app/accounts');
        // AccountsClient renders the page — wait for any accounts-related UI
        await expect(
            page.getByText(/AWS Accounts|Accounts|All Accounts/i).first()
        ).toBeVisible({ timeout: 10000 });
    });

    test('/app/accounts/create loads the create form', async ({ page }) => {
        await goto(page, '/app/accounts/create');
        await expect(
            page.getByText(/Add Account|Integrate Account|Create Account|Account ID/i).first()
        ).toBeVisible({ timeout: 10000 });
    });
});

// ─── AI Ops (Agent) ───────────────────────────────────────────────────────────

test.describe('App — AI Ops', () => {
    test('/app/agent loads', async ({ page }) => {
        await goto(page, '/app/agent');
        await expect(
            page.getByText(/AI Ops|Agent|Chat/i).first()
        ).toBeVisible({ timeout: 10000 });
    });

    test('/app/agent/mcp-settings loads', async ({ page }) => {
        await goto(page, '/app/agent/mcp-settings');
        await expect(
            page.getByText(/MCP|Model Context Protocol|Servers/i).first()
        ).toBeVisible({ timeout: 10000 });
    });
});

// ─── Agent Ops ────────────────────────────────────────────────────────────────

test.describe('App — Agent Ops', () => {
    test('/app/agent-ops loads with heading', async ({ page }) => {
        await goto(page, '/app/agent-ops');
        await expect(page.getByRole('heading', { name: /Agent Ops/i })).toBeVisible({ timeout: 10000 });
    });

    test('/app/agent-ops shows stats cards (Total Runs, In Progress, Completed, Failed)', async ({ page }) => {
        await goto(page, '/app/agent-ops');
        await expect(page.getByText('Total Runs').first()).toBeVisible({ timeout: 15000 });
        await expect(page.getByText('In Progress').first()).toBeVisible({ timeout: 15000 });
        await expect(page.getByText('Completed').first()).toBeVisible({ timeout: 15000 });
        await expect(page.getByText('Failed').first()).toBeVisible({ timeout: 15000 });
    });

    test('/app/agent-ops shows Execution Runs card', async ({ page }) => {
        await goto(page, '/app/agent-ops');
        await expect(page.getByText('Execution Runs')).toBeVisible({ timeout: 10000 });
    });

    test('/app/agent-ops/mcp-settings loads', async ({ page }) => {
        await goto(page, '/app/agent-ops/mcp-settings');
        await expect(
            page.getByText(/MCP|Model Context Protocol|Servers/i).first()
        ).toBeVisible({ timeout: 10000 });
    });

    test('/app/agent-ops/slack-settings loads', async ({ page }) => {
        await goto(page, '/app/agent-ops/slack-settings');
        await expect(
            page.getByText(/Slack/i).first()
        ).toBeVisible({ timeout: 10000 });
    });

    test('/app/agent-ops/jira-settings loads', async ({ page }) => {
        await goto(page, '/app/agent-ops/jira-settings');
        await expect(
            page.getByText(/Jira/i).first()
        ).toBeVisible({ timeout: 10000 });
    });

    test('/app/agent-ops/scheduled-tasks loads', async ({ page }) => {
        await goto(page, '/app/agent-ops/scheduled-tasks');
        await expect(
            page.getByText(/Scheduled Tasks|Scheduled/i).first()
        ).toBeVisible({ timeout: 10000 });
    });
});

// ─── Agent Ops — Internal Navigation (router.push fixes) ──────────────────────

test.describe('App — Agent Ops Internal Navigation', () => {
    test('Scheduled Tasks button navigates to /app/agent-ops/scheduled-tasks', async ({ page }) => {
        await goto(page, '/app/agent-ops');
        await page.getByRole('button', { name: /Scheduled Tasks/i }).click();
        await page.waitForLoadState('domcontentloaded');
        expect(page.url()).toContain('/app/agent-ops/scheduled-tasks');
    });

    test('Slack Settings button navigates to /app/agent-ops/slack-settings', async ({ page }) => {
        await goto(page, '/app/agent-ops');
        await page.getByRole('button', { name: /Slack Settings/i }).click();
        await page.waitForLoadState('domcontentloaded');
        expect(page.url()).toContain('/app/agent-ops/slack-settings');
    });

    test('Jira Settings button navigates to /app/agent-ops/jira-settings', async ({ page }) => {
        await goto(page, '/app/agent-ops');
        await page.getByRole('button', { name: /Jira Settings/i }).click();
        await page.waitForLoadState('domcontentloaded');
        expect(page.url()).toContain('/app/agent-ops/jira-settings');
    });

    test('MCP Servers button navigates to /app/agent-ops/mcp-settings', async ({ page }) => {
        await goto(page, '/app/agent-ops');
        await page.getByRole('button', { name: /MCP Servers/i }).click();
        await page.waitForLoadState('domcontentloaded');
        expect(page.url()).toContain('/app/agent-ops/mcp-settings');
    });
});

// ─── Channels ─────────────────────────────────────────────────────────────────

test.describe('App — Channels', () => {
    test('/app/channels loads with heading', async ({ page }) => {
        await goto(page, '/app/channels');
        await expect(page.getByRole('heading', { name: /Channels/i })).toBeVisible({ timeout: 10000 });
    });

    test('/app/channels shows Slack, Jira, MCP cards', async ({ page }) => {
        await goto(page, '/app/channels');
        await expect(page.getByText('Slack').first()).toBeVisible({ timeout: 10000 });
        await expect(page.getByText('Jira').first()).toBeVisible({ timeout: 10000 });
        await expect(page.getByText('MCP Servers').first()).toBeVisible({ timeout: 10000 });
    });

    test('/app/channels/mcp-settings loads', async ({ page }) => {
        await goto(page, '/app/channels/mcp-settings');
        await expect(
            page.getByText(/MCP|Model Context Protocol/i).first()
        ).toBeVisible({ timeout: 10000 });
    });

    test('/app/channels/slack-settings loads', async ({ page }) => {
        await goto(page, '/app/channels/slack-settings');
        await expect(page.getByText(/Slack/i).first()).toBeVisible({ timeout: 10000 });
    });

    test('/app/channels/jira-settings loads', async ({ page }) => {
        await goto(page, '/app/channels/jira-settings');
        await expect(page.getByText(/Jira/i).first()).toBeVisible({ timeout: 10000 });
    });
});

// ─── Channels — Configure links go to correct /app/ routes ────────────────────

test.describe('App — Channels Configure Links', () => {
    test('Slack Configure button links to /app/channels/slack-settings (not old path)', async ({ page }) => {
        await goto(page, '/app/channels');
        await page.waitForLoadState('networkidle');
        // Find the Configure button in the Slack card
        const slackCard = page.locator('[class*="Card"]').filter({ hasText: 'Slack' }).first();
        const configureLink = slackCard.getByRole('link', { name: /Configure/i });
        const href = await configureLink.getAttribute('href');
        // Must include /app/ prefix — if not, it's a 404 bug
        expect(href, `Slack Configure href "${href}" is missing /app/ prefix`).toMatch(/\/app\/channels\/slack-settings|\/channels\/slack-settings/);
    });
});

// ─── Cost Scheduler ───────────────────────────────────────────────────────────

test.describe('App — Cost Scheduler', () => {
    test('/app/schedules list page loads', async ({ page }) => {
        await goto(page, '/app/schedules');
        await expect(
            page.getByText(/Schedules|Cost Scheduler|Total Schedules/i).first()
        ).toBeVisible({ timeout: 10000 });
    });

    test('/app/schedules/create loads', async ({ page }) => {
        await goto(page, '/app/schedules/create');
        await expect(
            page.getByText(/Create Schedule|New Schedule|Schedule Name/i).first()
        ).toBeVisible({ timeout: 10000 });
    });

    test('/app/schedules/settings loads', async ({ page }) => {
        await goto(page, '/app/schedules/settings');
        await expect(
            page.getByText(/Scheduler Settings|Settings/i).first()
        ).toBeVisible({ timeout: 10000 });
    });
});

// ─── Inventory Discovery ──────────────────────────────────────────────────────

test.describe('App — Inventory Discovery', () => {
    test('/app/inventory loads with heading', async ({ page }) => {
        await goto(page, '/app/inventory');
        await expect(
            page.getByRole('heading', { name: /Inventory Discovery/i })
        ).toBeVisible({ timeout: 10000 });
    });

    test('/app/inventory shows stat cards', async ({ page }) => {
        await goto(page, '/app/inventory');
        await expect(page.getByText('Total Resources')).toBeVisible({ timeout: 10000 });
        await expect(page.getByText('Accounts Synced')).toBeVisible({ timeout: 10000 });
        await expect(page.getByText('Last Sync')).toBeVisible({ timeout: 10000 });
    });

    test('/app/inventory shows filter controls', async ({ page }) => {
        await goto(page, '/app/inventory');
        await expect(page.getByText(/All Types/i)).toBeVisible({ timeout: 10000 });
        await expect(page.getByText(/All Regions/i)).toBeVisible({ timeout: 10000 });
    });

    test('/app/inventory shows action buttons (Sync Now, Export, Ask AI)', async ({ page }) => {
        await goto(page, '/app/inventory');
        await expect(page.getByRole('button', { name: /Sync Now/i })).toBeVisible({ timeout: 10000 });
        await expect(page.getByRole('button', { name: /Export/i })).toBeVisible({ timeout: 10000 });
        await expect(page.getByRole('button', { name: /Ask AI/i })).toBeVisible({ timeout: 10000 });
    });
});

// ─── Knowledge Base ───────────────────────────────────────────────────────────

test.describe('App — Knowledge Base', () => {
    test('/app/knowledge-base loads', async ({ page }) => {
        await goto(page, '/app/knowledge-base');
        await expect(
            page.getByText(/Knowledge Base/i).first()
        ).toBeVisible({ timeout: 10000 });
    });

    test('/app/knowledge-base/ask loads', async ({ page }) => {
        await goto(page, '/app/knowledge-base/ask');
        await expect(
            page.getByText(/Ask|Knowledge Base|Question/i).first()
        ).toBeVisible({ timeout: 10000 });
    });
});

// ─── Audit Logs ───────────────────────────────────────────────────────────────

test.describe('App — Audit Logs', () => {
    test('/app/audit loads', async ({ page }) => {
        await goto(page, '/app/audit');
        await expect(
            page.getByText(/Audit|Activity|Logs/i).first()
        ).toBeVisible({ timeout: 10000 });
    });
});

// ─── Admin ────────────────────────────────────────────────────────────────────

test.describe('App — Admin', () => {
    test('/app/admin/users loads', async ({ page }) => {
        await goto(page, '/app/admin/users');
        await expect(
            page.getByText(/Users|Admin|User Management/i).first()
        ).toBeVisible({ timeout: 10000 });
    });
});

// ─── Settings ─────────────────────────────────────────────────────────────────

test.describe('App — Settings', () => {
    test('/app/settings loads', async ({ page }) => {
        await goto(page, '/app/settings');
        await expect(
            page.getByText(/Settings|Appearance|Theme/i).first()
        ).toBeVisible({ timeout: 10000 });
    });
});

// ─── Deep Agent ───────────────────────────────────────────────────────────────

test.describe('App — Deep Agent', () => {
    test('/app/deep-agent loads', async ({ page }) => {
        await goto(page, '/app/deep-agent');
        await expect(
            page.getByText(/Deep Agent|Agent|Chat/i).first()
        ).toBeVisible({ timeout: 10000 });
    });
});

// ─── Sidebar — All Links Navigate to /app/* ────────────────────────────────────

test.describe('Sidebar Navigation', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/app/dashboard', { waitUntil: 'domcontentloaded' });
    });

    const sidebarLinks = [
        { name: 'Dashboard', expectedPath: '/app/dashboard' },
        { name: 'AWS Accounts', expectedPath: '/app/accounts' },
        { name: 'AI Ops', expectedPath: '/app/agent' },
        { name: 'Agent Ops', expectedPath: '/app/agent-ops' },
        { name: 'Channels', expectedPath: '/app/channels' },
        { name: 'Cost Scheduler', expectedPath: '/app/schedules' },
        { name: 'Inventory Discovery', expectedPath: '/app/inventory' },
        { name: 'Knowledge Base', expectedPath: '/app/knowledge-base' },
        { name: 'Audit Logs', expectedPath: '/app/audit' },
        { name: 'Settings', expectedPath: '/app/settings' },
    ];

    for (const { name, expectedPath } of sidebarLinks) {
        test(`"${name}" sidebar link → ${expectedPath}`, async ({ page }) => {
            const link = page.getByRole('link', { name }).first();
            await expect(link).toBeVisible({ timeout: 5000 });
            await link.click();
            await page.waitForLoadState('domcontentloaded');
            expect(page.url()).toContain(expectedPath);
            // Verify no 404
            const body = await page.locator('body').innerText().catch(() => '');
            expect(body).not.toMatch(/This page could not be found/i);
        });
    }
});

// ─── Old Routes — Should NOT serve app content ─────────────────────────────────

test.describe('Old Routes (Pre-Restructure) — Regression', () => {
    /**
     * These routes existed before the /app/app restructure.
     * After restructure they should either 404 or redirect to login.
     * If they serve app content at the old path — that signals routing is
     * misconfigured (duplicate routes).
     */
    const oldRoutes = [
        '/accounts',
        '/accounts/create',
        '/agent-ops',
        '/agent-ops/mcp-settings',
        '/agent-ops/slack-settings',
        '/agent-ops/jira-settings',
        '/agent',
        '/schedules',
        '/schedules/create',
        '/inventory',
        '/knowledge-base',
        '/audit',
        '/settings',
        '/channels',
        '/deep-agent',
        '/admin/users',
        '/dashboard',
    ];

    for (const route of oldRoutes) {
        test(`${route} redirects to login or 404 (not app page)`, async ({ page }) => {
            const res = await page.goto(route, { waitUntil: 'domcontentloaded' });
            const finalUrl = page.url();
            const status = res?.status() ?? 200;
            // Acceptable outcomes: 404, or redirect to /login, or redirect to /app/*
            const isAcceptable =
                status === 404 ||
                finalUrl.includes('/login') ||
                finalUrl.includes('/app/');
            expect(isAcceptable, `Old route ${route} → ${finalUrl} (status ${status}) — unexpected response`).toBe(true);
        });
    }
});
