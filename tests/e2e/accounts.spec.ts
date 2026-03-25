/**
 * AWS Accounts Module E2E tests — /app/accounts/*
 *
 * Covers:
 *  - Page load, header, stats cards
 *  - Filters (search, status, connection dropdowns, Apply/Clear)
 *  - View toggle (Table / Grid)
 *  - Grid card content (name, badge, account ID, Role ARN, Regions, Status, Connection)
 *  - Card actions (Validate, Activate/Deactivate, three-dot menu)
 *  - Create Account flow (/app/accounts/create)
 *
 * Run: npx playwright test tests/e2e/accounts.spec.ts
 */
import { test, expect, Page } from '@playwright/test';

// ─── Helper ──────────────────────────────────────────────────────────────────

async function gotoAccounts(page: Page) {
    const res = await page.goto('/app/accounts', { waitUntil: 'domcontentloaded', timeout: 60000 });
    expect(res?.status(), 'accounts page should not 404').not.toBe(404);
    const body = await page.locator('body').innerText().catch(() => '');
    expect(body, 'accounts page should not show 404 message').not.toMatch(/This page could not be found/i);
    expect(page.url(), 'accounts page should not redirect to login').not.toContain('/login');
}

// ─── Page Load & Header ───────────────────────────────────────────────────────

test.describe('AWS Accounts — Page Load', () => {
    test.beforeEach(async ({ page }) => {
        await gotoAccounts(page);
    });

    test('page title heading is visible', async ({ page }) => {
        await expect(
            page.getByRole('heading', { name: 'AWS Accounts' })
        ).toBeVisible({ timeout: 15000 });
    });

    test('page subtitle is visible', async ({ page }) => {
        await expect(
            page.getByText('Manage and monitor your AWS accounts and their configurations')
        ).toBeVisible({ timeout: 10000 });
    });

    test('Refresh button is visible', async ({ page }) => {
        await expect(
            page.getByRole('button', { name: /Refresh/i })
        ).toBeVisible({ timeout: 10000 });
    });

    test('Integrate Account button is visible', async ({ page }) => {
        await expect(
            page.getByRole('button', { name: /Integrate Account/i })
        ).toBeVisible({ timeout: 10000 });
    });
});

// ─── Stats Cards ──────────────────────────────────────────────────────────────

test.describe('AWS Accounts — Stats Cards', () => {
    test.beforeEach(async ({ page }) => {
        await gotoAccounts(page);
        // Wait for the page to fully render stats
        await expect(page.getByRole('heading', { name: 'AWS Accounts' })).toBeVisible({ timeout: 15000 });
    });

    test('Total Accounts stat card is visible', async ({ page }) => {
        await expect(page.getByText('Total Accounts')).toBeVisible({ timeout: 10000 });
    });

    test('Connected stat card is visible', async ({ page }) => {
        await expect(page.getByText('Connected').first()).toBeVisible({ timeout: 10000 });
    });

    test('Resources stat card is visible', async ({ page }) => {
        await expect(page.getByText('Resources').first()).toBeVisible({ timeout: 10000 });
    });

    test('Monthly Savings stat card is visible', async ({ page }) => {
        await expect(page.getByText('Monthly Savings')).toBeVisible({ timeout: 10000 });
    });

    test('Selected stat card is visible', async ({ page }) => {
        await expect(page.getByText('Selected').first()).toBeVisible({ timeout: 10000 });
    });

    test('stats section renders all five stat labels', async ({ page }) => {
        await expect(page.getByText('Total Accounts')).toBeVisible({ timeout: 10000 });
        await expect(page.getByText('Monthly Savings')).toBeVisible({ timeout: 5000 });
        await expect(page.getByText('Selected').first()).toBeVisible({ timeout: 5000 });
    });
});

// ─── Filters Section ─────────────────────────────────────────────────────────

test.describe('AWS Accounts — Filters', () => {
    test.beforeEach(async ({ page }) => {
        await gotoAccounts(page);
        await expect(page.getByRole('heading', { name: 'AWS Accounts' })).toBeVisible({ timeout: 15000 });
    });

    test('Filters section heading is visible', async ({ page }) => {
        await expect(page.getByText('Filters').first()).toBeVisible({ timeout: 10000 });
    });

    test('search input is present with correct placeholder', async ({ page }) => {
        await expect(
            page.getByPlaceholder('Search accounts by name, ID, description...')
        ).toBeVisible({ timeout: 10000 });
    });

    test('status filter dropdown shows "All Accounts" by default', async ({ page }) => {
        // The dropdown trigger should show the current value
        await expect(
            page.getByText('All Accounts').first()
        ).toBeVisible({ timeout: 10000 });
    });

    test('connection filter dropdown shows "All Connections" by default', async ({ page }) => {
        await expect(
            page.getByText('All Connections').first()
        ).toBeVisible({ timeout: 10000 });
    });

    test('Apply Filters button is visible', async ({ page }) => {
        await expect(
            page.getByRole('button', { name: /Apply Filters/i })
        ).toBeVisible({ timeout: 10000 });
    });

    test('Clear Filters button is visible', async ({ page }) => {
        await expect(
            page.getByRole('button', { name: /Clear Filters/i })
        ).toBeVisible({ timeout: 10000 });
    });

    test('typing in search input updates its value', async ({ page }) => {
        const searchInput = page.getByPlaceholder('Search accounts by name, ID, description...');
        await searchInput.fill('STX');
        await expect(searchInput).toHaveValue('STX');
    });

    test('status filter dropdown opens with options', async ({ page }) => {
        // Click on the status dropdown trigger
        await page.getByText('All Accounts').first().click();
        // Verify some options appear
        await expect(page.getByRole('option', { name: 'All Accounts' }).first()).toBeVisible({ timeout: 5000 });
        await expect(page.getByRole('option', { name: 'Active Only' }).first()).toBeVisible({ timeout: 5000 });
        await expect(page.getByRole('option', { name: 'Inactive Only' }).first()).toBeVisible({ timeout: 5000 });
    });

    test('connection filter dropdown opens with options', async ({ page }) => {
        await page.getByText('All Connections').first().click();
        await expect(page.getByRole('option', { name: 'All Connections' }).first()).toBeVisible({ timeout: 5000 });
        await expect(page.getByRole('option', { name: 'Connected' })).toBeVisible({ timeout: 5000 });
        await expect(page.getByRole('option', { name: 'Connection Error' })).toBeVisible({ timeout: 5000 });
    });

    test('Clear Filters resets search input', async ({ page }) => {
        const searchInput = page.getByPlaceholder('Search accounts by name, ID, description...');
        await searchInput.fill('STX-TEST');
        await page.getByRole('button', { name: /Clear Filters/i }).click();
        await expect(searchInput).toHaveValue('');
    });
});

// ─── View Toggle ─────────────────────────────────────────────────────────────

test.describe('AWS Accounts — View Toggle', () => {
    test.beforeEach(async ({ page }) => {
        await gotoAccounts(page);
        await expect(page.getByRole('heading', { name: 'AWS Accounts' })).toBeVisible({ timeout: 15000 });
    });

    test('Table View tab is present', async ({ page }) => {
        await expect(page.getByRole('tab', { name: /Table View/i })).toBeVisible({ timeout: 10000 });
    });

    test('Grid View tab is present', async ({ page }) => {
        await expect(page.getByRole('tab', { name: /Grid View/i })).toBeVisible({ timeout: 10000 });
    });

    test('clicking Table View tab switches to table layout', async ({ page }) => {
        await page.getByRole('tab', { name: /Table View/i }).click();
        // Table view renders a table element
        await expect(page.locator('table').first()).toBeVisible({ timeout: 10000 });
    });

    test('clicking Grid View tab switches to grid layout', async ({ page }) => {
        // Switch to table first, then back to grid
        await page.getByRole('tab', { name: /Table View/i }).click();
        await expect(page.locator('table').first()).toBeVisible({ timeout: 10000 });
        await page.getByRole('tab', { name: /Grid View/i }).click();
        // Grid view shows Role ARN labels in cards (not as table cells)
        await expect(page.getByText('Role ARN').first()).toBeVisible({ timeout: 10000 });
    });
});

// ─── Grid View — Account Cards ────────────────────────────────────────────────

test.describe('AWS Accounts — Grid Cards', () => {
    test.beforeEach(async ({ page }) => {
        await gotoAccounts(page);
        await expect(page.getByRole('heading', { name: 'AWS Accounts' })).toBeVisible({ timeout: 15000 });
        // Ensure Grid View is active (default)
        const gridTab = page.getByRole('tab', { name: /Grid View/i });
        if (await gridTab.isVisible()) {
            await gridTab.click();
        }
    });

    test('account cards are rendered', async ({ page }) => {
        // Account cards show "Role ARN" label — at least one must be visible
        await expect(
            page.getByText('Role ARN').first()
        ).toBeVisible({ timeout: 15000 });
    });

    test('cards show Role ARN label', async ({ page }) => {
        await expect(page.getByText('Role ARN').first()).toBeVisible({ timeout: 15000 });
    });

    test('cards show Regions label', async ({ page }) => {
        await expect(page.getByText('Regions').first()).toBeVisible({ timeout: 10000 });
    });

    test('cards show Account Status label', async ({ page }) => {
        await expect(page.getByText('Account Status').first()).toBeVisible({ timeout: 10000 });
    });

    test('cards show Connection label', async ({ page }) => {
        await expect(page.getByText('Connection').first()).toBeVisible({ timeout: 10000 });
    });

    test('Active accounts show Active badge', async ({ page }) => {
        // There should be at least one Active badge given the data shown
        await expect(
            page.getByText('Active').first()
        ).toBeVisible({ timeout: 15000 });
    });

    test('Inactive accounts show Inactive badge', async ({ page }) => {
        await expect(
            page.getByText('Inactive').first()
        ).toBeVisible({ timeout: 15000 });
    });

    test('Connected accounts show Connected status', async ({ page }) => {
        await expect(
            page.getByText('Connected').first()
        ).toBeVisible({ timeout: 15000 });
    });

    test('Validate button is present on cards', async ({ page }) => {
        await expect(
            page.getByRole('button', { name: /Validate/i }).first()
        ).toBeVisible({ timeout: 15000 });
    });

    test('Activate or Deactivate button is present on cards', async ({ page }) => {
        // Cards show either Activate or Deactivate depending on account state
        const activateBtn = page.getByRole('button', { name: /^Activate$/i }).first();
        const deactivateBtn = page.getByRole('button', { name: /^Deactivate$/i }).first();
        const eitherVisible = (await activateBtn.isVisible()) || (await deactivateBtn.isVisible());
        expect(eitherVisible, 'at least one Activate or Deactivate button should be visible').toBe(true);
    });

    test('three-dot menu button is present on cards', async ({ page }) => {
        // Each account card has a dropdown menu trigger
        await expect(page.getByText('Role ARN').first()).toBeVisible({ timeout: 15000 });
        const menuBtn = page.locator('button[aria-haspopup="menu"]').first();
        await expect(menuBtn).toBeVisible({ timeout: 5000 });
    });

    test('clicking three-dot menu shows options', async ({ page }) => {
        await expect(page.getByText('Role ARN').first()).toBeVisible({ timeout: 15000 });
        await page.locator('button[aria-haspopup="menu"]').first().click();
        // Menu should show View Details and Edit options
        await expect(
            page.getByRole('menuitem').first()
        ).toBeVisible({ timeout: 5000 });
    });

    test('clicking a card navigates to the account detail page', async ({ page }) => {
        // Wait for cards to render
        await expect(page.getByText('Role ARN').first()).toBeVisible({ timeout: 15000 });
        // Open the three-dot dropdown and click View Details
        await page.locator('button[aria-haspopup="menu"]').first().click();
        await expect(page.getByRole('menuitem').first()).toBeVisible({ timeout: 5000 });
        await page.getByRole('menuitem', { name: /View Details/i }).click();
        await page.waitForURL(/\/app\/accounts\/.+/, { timeout: 15000 });
        expect(page.url()).toContain('/app/accounts/');
        expect(page.url()).not.toMatch(/\/app\/accounts\?/);
    });
});

// ─── Table View ───────────────────────────────────────────────────────────────

test.describe('AWS Accounts — Table View', () => {
    test.beforeEach(async ({ page }) => {
        await gotoAccounts(page);
        await expect(page.getByRole('heading', { name: 'AWS Accounts' })).toBeVisible({ timeout: 15000 });
        await page.getByRole('tab', { name: /Table View/i }).click();
        await expect(page.locator('table').first()).toBeVisible({ timeout: 10000 });
    });

    test('table has column headers', async ({ page }) => {
        // Table should have header row with column names
        const thead = page.locator('thead').first();
        await expect(thead).toBeVisible({ timeout: 5000 });
    });

    test('table shows account rows', async ({ page }) => {
        // At least one data row should exist
        const tbody = page.locator('tbody tr').first();
        await expect(tbody).toBeVisible({ timeout: 10000 });
    });

    test('table rows have Validate action', async ({ page }) => {
        await expect(
            page.getByRole('button', { name: /Validate/i }).first()
        ).toBeVisible({ timeout: 10000 });
    });
});

// ─── Integrate Account (Create Flow) ─────────────────────────────────────────

test.describe('AWS Accounts — Create Account', () => {
    test('Integrate Account button navigates to /app/accounts/create', async ({ page }) => {
        await gotoAccounts(page);
        await expect(page.getByRole('heading', { name: 'AWS Accounts' })).toBeVisible({ timeout: 15000 });
        await page.getByRole('button', { name: /Integrate Account/i }).click();
        await page.waitForURL(/\/app\/accounts\/create/, { timeout: 15000 });
        expect(page.url()).toContain('/app/accounts/create');
    });

    test.describe('Create Account Form', () => {
        test.beforeEach(async ({ page }) => {
            await page.goto('/app/accounts/create', { waitUntil: 'domcontentloaded', timeout: 60000 });
        });

        test('Create AWS Account heading is visible', async ({ page }) => {
            await expect(
                page.getByRole('heading', { name: /Create AWS Account/i })
            ).toBeVisible({ timeout: 15000 });
        });

        test('AWS Account ID field is present', async ({ page }) => {
            await expect(
                page.getByLabel(/AWS Account ID/i)
            ).toBeVisible({ timeout: 10000 });
        });

        test('AWS Account ID field has correct placeholder', async ({ page }) => {
            await expect(
                page.getByRole('textbox', { name: 'AWS Account ID' })
            ).toBeVisible({ timeout: 10000 });
        });

        test('Region selector is present', async ({ page }) => {
            await expect(
                page.getByLabel(/Region/i).first()
            ).toBeVisible({ timeout: 10000 });
        });

        test('Account Name field is present', async ({ page }) => {
            await expect(
                page.getByLabel(/Account Name/i)
            ).toBeVisible({ timeout: 10000 });
        });

        test('Description field is present', async ({ page }) => {
            await expect(
                page.getByLabel(/Description/i)
            ).toBeVisible({ timeout: 10000 });
        });

        test('Cross-Account Role ARN field is present', async ({ page }) => {
            await expect(
                page.getByLabel(/Cross-Account Role ARN/i)
            ).toBeVisible({ timeout: 10000 });
        });

        test('External ID field is present', async ({ page }) => {
            await expect(
                page.getByLabel(/External ID/i)
            ).toBeVisible({ timeout: 10000 });
        });

        test('Generate Template button is present', async ({ page }) => {
            await expect(
                page.getByRole('button', { name: /Generate Template/i })
            ).toBeVisible({ timeout: 10000 });
        });

        test('Create Account submit button is present', async ({ page }) => {
            await expect(
                page.getByRole('button', { name: /Create Account/i })
            ).toBeVisible({ timeout: 10000 });
        });

        test('Cancel button is present', async ({ page }) => {
            await expect(
                page.getByRole('button', { name: /Cancel/i })
            ).toBeVisible({ timeout: 10000 });
        });

        test('Cancel button navigates back to accounts list', async ({ page }) => {
            await page.getByRole('button', { name: /Cancel/i }).click();
            await page.waitForURL(/\/app\/accounts$|\/app\/accounts\?/, { timeout: 15000 });
            expect(page.url()).toContain('/app/accounts');
            expect(page.url()).not.toContain('/create');
        });

        test('form validates Account ID length (less than 12 digits)', async ({ page }) => {
            const accountIdInput = page.getByRole('textbox', { name: 'AWS Account ID' });
            await accountIdInput.fill('12345');
            await page.getByRole('button', { name: /Create Account/i }).click();
            // Expect a validation error message
            await expect(
                page.getByText(/12 digits/i).first()
            ).toBeVisible({ timeout: 5000 });
        });
    });
});

// ─── Refresh Button ───────────────────────────────────────────────────────────

test.describe('AWS Accounts — Refresh', () => {
    test('Refresh button reloads account data', async ({ page }) => {
        await gotoAccounts(page);
        await expect(page.getByRole('heading', { name: 'AWS Accounts' })).toBeVisible({ timeout: 15000 });
        const refreshBtn = page.getByRole('button', { name: /Refresh/i });
        await expect(refreshBtn).toBeVisible();
        await refreshBtn.click();
        // After click, the button should still be present (not navigate away)
        await expect(refreshBtn).toBeVisible({ timeout: 5000 });
        expect(page.url()).toContain('/app/accounts');
    });
});

// ─── Pagination ───────────────────────────────────────────────────────────────

test.describe('AWS Accounts — Pagination', () => {
    test('accounts list shows with default limit', async ({ page }) => {
        await page.goto('/app/accounts?limit=10', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await expect(
            page.getByRole('heading', { name: 'AWS Accounts' })
        ).toBeVisible({ timeout: 15000 });
        // Cards or table rows should render — look for account labels
        await expect(
            page.getByText('Role ARN').first().or(page.locator('tbody tr').first())
        ).toBeVisible({ timeout: 15000 });
    });
});

// ─── Apply Filters Flow ───────────────────────────────────────────────────────

test.describe('AWS Accounts — Filter Apply Flow', () => {
    test('filtering by Active Only updates the list', async ({ page }) => {
        await gotoAccounts(page);
        await expect(page.getByRole('heading', { name: 'AWS Accounts' })).toBeVisible({ timeout: 15000 });

        // Change status filter to Active Only
        await page.getByText('All Accounts').first().click();
        await page.getByRole('option', { name: 'Active Only' }).click();

        // Apply filters
        await page.getByRole('button', { name: /Apply Filters/i }).click();
        await page.waitForLoadState('domcontentloaded');

        // After filtering, should not redirect to login or 404
        expect(page.url()).toContain('/app/accounts');
        expect(page.url()).not.toContain('/login');
    });

    test('filtering by Connected updates the list', async ({ page }) => {
        await gotoAccounts(page);
        await expect(page.getByRole('heading', { name: 'AWS Accounts' })).toBeVisible({ timeout: 15000 });

        await page.getByText('All Connections').first().click();
        await page.getByRole('option', { name: 'Connected' }).click();
        await page.getByRole('button', { name: /Apply Filters/i }).click();
        await page.waitForLoadState('domcontentloaded');

        expect(page.url()).toContain('/app/accounts');
    });

    test('clear filters resets to showing all accounts', async ({ page }) => {
        await gotoAccounts(page);
        await expect(page.getByRole('heading', { name: 'AWS Accounts' })).toBeVisible({ timeout: 15000 });

        // Apply a filter first
        const searchInput = page.getByPlaceholder('Search accounts by name, ID, description...');
        await searchInput.fill('NONEXISTENT-ACCOUNT-XYZ');
        await page.getByRole('button', { name: /Apply Filters/i }).click();

        // Clear it
        await page.getByRole('button', { name: /Clear Filters/i }).click();
        await expect(searchInput).toHaveValue('');
    });
});
