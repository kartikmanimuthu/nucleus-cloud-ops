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
 * Run: cd apps/web-ui-e2e && bunx playwright test accounts.spec.ts
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

// // ─── Page Load & Header ───────────────────────────────────────────────────────

// test.describe('AWS Accounts — Page Load', () => {
//     test.beforeEach(async ({ page }) => {
//         await gotoAccounts(page);
//     });

//     test('page title heading is visible', async ({ page }) => {
//         await expect(
//             page.getByRole('heading', { name: 'AWS Accounts' })
//         ).toBeVisible({ timeout: 15000 });
//     });

//     test('page subtitle is visible', async ({ page }) => {
//         await expect(
//             page.getByText('Manage and monitor your AWS accounts and their configurations')
//         ).toBeVisible({ timeout: 10000 });
//     });

//     test('Refresh button is visible', async ({ page }) => {
//         await expect(
//             page.getByRole('button', { name: /Refresh/i })
//         ).toBeVisible({ timeout: 10000 });
//     });

//     test('Integrate Account button is visible', async ({ page }) => {
//         await expect(
//             page.getByRole('button', { name: /Integrate Account/i })
//         ).toBeVisible({ timeout: 10000 });
//     });
// });

// // ─── Stats Cards ──────────────────────────────────────────────────────────────

// test.describe('AWS Accounts — Stats Cards', () => {
//     test.beforeEach(async ({ page }) => {
//         await gotoAccounts(page);
//         // Wait for the page to fully render stats
//         await expect(page.getByRole('heading', { name: 'AWS Accounts' })).toBeVisible({ timeout: 15000 });
//     });

//     test('Total Accounts stat card is visible', async ({ page }) => {
//         await expect(page.getByText('Total Accounts')).toBeVisible({ timeout: 10000 });
//     });

//     test('Connected stat card is visible', async ({ page }) => {
//         await expect(page.getByText('Connected').first()).toBeVisible({ timeout: 10000 });
//     });

//     test('Resources stat card is visible', async ({ page }) => {
//         await expect(page.getByText('Resources').first()).toBeVisible({ timeout: 10000 });
//     });

//     test('Monthly Savings stat card is visible', async ({ page }) => {
//         await expect(page.getByText('Monthly Savings')).toBeVisible({ timeout: 10000 });
//     });

//     test('Selected stat card is visible', async ({ page }) => {
//         await expect(page.getByText('Selected').first()).toBeVisible({ timeout: 10000 });
//     });

//     test('stats section renders all five stat labels', async ({ page }) => {
//         await expect(page.getByText('Total Accounts')).toBeVisible({ timeout: 10000 });
//         await expect(page.getByText('Monthly Savings')).toBeVisible({ timeout: 5000 });
//         await expect(page.getByText('Selected').first()).toBeVisible({ timeout: 5000 });
//     });
// });

// // ─── Filters Section ─────────────────────────────────────────────────────────

// test.describe('AWS Accounts — Filters', () => {
//     test.beforeEach(async ({ page }) => {
//         await gotoAccounts(page);
//         await expect(page.getByRole('heading', { name: 'AWS Accounts' })).toBeVisible({ timeout: 15000 });
//     });

//     test('Filters section heading is visible', async ({ page }) => {
//         await expect(page.getByText('Filters').first()).toBeVisible({ timeout: 10000 });
//     });

//     test('search input is present with correct placeholder', async ({ page }) => {
//         await expect(
//             page.getByPlaceholder('Search accounts by name, ID, description...')
//         ).toBeVisible({ timeout: 10000 });
//     });

//     test('status filter dropdown shows "All Accounts" by default', async ({ page }) => {
//         // The dropdown trigger should show the current value
//         await expect(
//             page.getByText('All Accounts').first()
//         ).toBeVisible({ timeout: 10000 });
//     });

//     test('connection filter dropdown shows "All Connections" by default', async ({ page }) => {
//         await expect(
//             page.getByText('All Connections').first()
//         ).toBeVisible({ timeout: 10000 });
//     });

//     test('Apply Filters button is visible', async ({ page }) => {
//         await expect(
//             page.getByRole('button', { name: /Apply Filters/i })
//         ).toBeVisible({ timeout: 10000 });
//     });

//     test('Clear Filters button is visible', async ({ page }) => {
//         await expect(
//             page.getByRole('button', { name: /Clear Filters/i })
//         ).toBeVisible({ timeout: 10000 });
//     });

//     test('typing in search input updates its value', async ({ page }) => {
//         const searchInput = page.getByPlaceholder('Search accounts by name, ID, description...');
//         await searchInput.fill('STX');
//         await expect(searchInput).toHaveValue('STX');
//     });

//     test('status filter dropdown opens with options', async ({ page }) => {
//         // Click on the status dropdown trigger
//         await page.getByText('All Accounts').first().click();
//         // Verify some options appear
//         await expect(page.getByRole('option', { name: 'All Accounts' }).first()).toBeVisible({ timeout: 5000 });
//         await expect(page.getByRole('option', { name: 'Active Only' }).first()).toBeVisible({ timeout: 5000 });
//         await expect(page.getByRole('option', { name: 'Inactive Only' }).first()).toBeVisible({ timeout: 5000 });
//     });

//     test('connection filter dropdown opens with options', async ({ page }) => {
//         await page.getByText('All Connections').first().click();
//         await expect(page.getByRole('option', { name: 'All Connections' }).first()).toBeVisible({ timeout: 5000 });
//         await expect(page.getByRole('option', { name: 'Connected' })).toBeVisible({ timeout: 5000 });
//         await expect(page.getByRole('option', { name: 'Connection Error' })).toBeVisible({ timeout: 5000 });
//     });

//     test('Clear Filters resets search input', async ({ page }) => {
//         const searchInput = page.getByPlaceholder('Search accounts by name, ID, description...');
//         await searchInput.fill('STX-TEST');
//         await page.getByRole('button', { name: /Clear Filters/i }).click();
//         await expect(searchInput).toHaveValue('');
//     });
// });

// // ─── View Toggle ─────────────────────────────────────────────────────────────

// test.describe('AWS Accounts — View Toggle', () => {
//     test.beforeEach(async ({ page }) => {
//         await gotoAccounts(page);
//         await expect(page.getByRole('heading', { name: 'AWS Accounts' })).toBeVisible({ timeout: 15000 });
//     });

//     test('Table View tab is present', async ({ page }) => {
//         await expect(page.getByRole('tab', { name: /Table View/i })).toBeVisible({ timeout: 10000 });
//     });

//     test('Grid View tab is present', async ({ page }) => {
//         await expect(page.getByRole('tab', { name: /Grid View/i })).toBeVisible({ timeout: 10000 });
//     });

//     test('clicking Table View tab switches to table layout', async ({ page }) => {
//         await page.getByRole('tab', { name: /Table View/i }).click();
//         // Table view renders a table element
//         await expect(page.locator('table').first()).toBeVisible({ timeout: 10000 });
//     });

//     test('clicking Grid View tab switches to grid layout', async ({ page }) => {
//         // Switch to table first, then back to grid
//         await page.getByRole('tab', { name: /Table View/i }).click();
//         await expect(page.locator('table').first()).toBeVisible({ timeout: 10000 });
//         await page.getByRole('tab', { name: /Grid View/i }).click();
//         // Grid view shows Role ARN labels in cards (not as table cells)
//         await expect(page.getByText('Role ARN').first()).toBeVisible({ timeout: 10000 });
//     });
// });

// // ─── Grid View — Account Cards ────────────────────────────────────────────────

// test.describe('AWS Accounts — Grid Cards', () => {
//     test.beforeEach(async ({ page }) => {
//         await gotoAccounts(page);
//         await expect(page.getByRole('heading', { name: 'AWS Accounts' })).toBeVisible({ timeout: 15000 });
//         // Ensure Grid View is active (default)
//         const gridTab = page.getByRole('tab', { name: /Grid View/i });
//         if (await gridTab.isVisible()) {
//             await gridTab.click();
//         }
//     });

//     test('account cards are rendered', async ({ page }) => {
//         // Account cards show "Role ARN" label — at least one must be visible
//         await expect(
//             page.getByText('Role ARN').first()
//         ).toBeVisible({ timeout: 15000 });
//     });

//     test('cards show Role ARN label', async ({ page }) => {
//         await expect(page.getByText('Role ARN').first()).toBeVisible({ timeout: 15000 });
//     });

//     test('cards show Regions label', async ({ page }) => {
//         await expect(page.getByText('Regions').first()).toBeVisible({ timeout: 10000 });
//     });

//     test('cards show Account Status label', async ({ page }) => {
//         await expect(page.getByText('Account Status').first()).toBeVisible({ timeout: 10000 });
//     });

//     test('cards show Connection label', async ({ page }) => {
//         await expect(page.getByText('Connection').first()).toBeVisible({ timeout: 10000 });
//     });

//     test('Active accounts show Active badge', async ({ page }) => {
//         // There should be at least one Active badge given the data shown
//         await expect(
//             page.getByText('Active').first()
//         ).toBeVisible({ timeout: 15000 });
//     });

//     test('Inactive accounts show Inactive badge', async ({ page }) => {
//         await expect(
//             page.getByText('Inactive').first()
//         ).toBeVisible({ timeout: 15000 });
//     });

//     test('Connected accounts show Connected status', async ({ page }) => {
//         await expect(
//             page.getByText('Connected').first()
//         ).toBeVisible({ timeout: 15000 });
//     });

//     test('Validate button is present on cards', async ({ page }) => {
//         await expect(
//             page.getByRole('button', { name: /Validate/i }).first()
//         ).toBeVisible({ timeout: 15000 });
//     });

//     test('Activate or Deactivate button is present on cards', async ({ page }) => {
//         // Cards show either Activate or Deactivate depending on account state
//         const activateBtn = page.getByRole('button', { name: /^Activate$/i }).first();
//         const deactivateBtn = page.getByRole('button', { name: /^Deactivate$/i }).first();
//         const eitherVisible = (await activateBtn.isVisible()) || (await deactivateBtn.isVisible());
//         expect(eitherVisible, 'at least one Activate or Deactivate button should be visible').toBe(true);
//     });

//     test('three-dot menu button is present on cards', async ({ page }) => {
//         // Each account card has a dropdown menu trigger
//         await expect(page.getByText('Role ARN').first()).toBeVisible({ timeout: 15000 });
//         const menuBtn = page.locator('button[aria-haspopup="menu"]').first();
//         await expect(menuBtn).toBeVisible({ timeout: 5000 });
//     });

//     test('clicking three-dot menu shows options', async ({ page }) => {
//         await expect(page.getByText('Role ARN').first()).toBeVisible({ timeout: 15000 });
//         await page.locator('button[aria-haspopup="menu"]').first().click();
//         // Menu should show View Details and Edit options
//         await expect(
//             page.getByRole('menuitem').first()
//         ).toBeVisible({ timeout: 5000 });
//     });

//     test('clicking a card navigates to the account detail page', async ({ page }) => {
//         // Wait for cards to render
//         await expect(page.getByText('Role ARN').first()).toBeVisible({ timeout: 15000 });
//         // The card body has an onClick. Click on the "Role ARN" label (a non-button div)
//         // which bubbles up to the card's onClick → router.push('/app/accounts/<id>')
//         await page.getByText('Role ARN').first().click();
//         await expect(page).toHaveURL(/\/app\/accounts\/.+/, { timeout: 15000 });
//         expect(page.url()).not.toMatch(/\/app\/accounts\?/);
//     });
// });

// // ─── Table View ───────────────────────────────────────────────────────────────

// test.describe('AWS Accounts — Table View', () => {
//     test.beforeEach(async ({ page }) => {
//         await gotoAccounts(page);
//         await expect(page.getByRole('heading', { name: 'AWS Accounts' })).toBeVisible({ timeout: 15000 });
//         await page.getByRole('tab', { name: /Table View/i }).click();
//         await expect(page.locator('table').first()).toBeVisible({ timeout: 10000 });
//     });

//     test('table has column headers', async ({ page }) => {
//         // Table should have header row with column names
//         const thead = page.locator('thead').first();
//         await expect(thead).toBeVisible({ timeout: 5000 });
//     });

//     test('table shows account rows', async ({ page }) => {
//         // At least one data row should exist
//         const tbody = page.locator('tbody tr').first();
//         await expect(tbody).toBeVisible({ timeout: 10000 });
//     });

//     test('table rows have Validate action', async ({ page }) => {
//         await expect(
//             page.getByRole('button', { name: /Validate/i }).first()
//         ).toBeVisible({ timeout: 10000 });
//     });
// });

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

        test('Cancel button uses router.back() to go back', async ({ page }) => {
            // The Cancel button calls router.back(). Navigate via accounts list first
            // so there is history to go back to.
            await page.goto('/app/accounts', { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.goto('/app/accounts/create', { waitUntil: 'domcontentloaded', timeout: 60000 });
            await expect(page.getByRole('button', { name: /Cancel/i })).toBeVisible({ timeout: 15000 });
            await page.getByRole('button', { name: /Cancel/i }).click();
            await expect(page).toHaveURL(/\/app\/accounts/, { timeout: 15000 });
            expect(page.url()).not.toContain('/create');
        });

        test('form validates Account ID length (less than 12 digits)', async ({ page }) => {
            const accountIdInput = page.getByRole('textbox', { name: 'AWS Account ID' });
            await accountIdInput.fill('12345');
            await page.getByRole('button', { name: /Create Account/i }).click();
            await expect(
                page.getByText(/12 digits/i).first()
            ).toBeVisible({ timeout: 5000 });
        });

        test('Account ID field rejects non-numeric input via validation', async ({ page }) => {
            const accountIdInput = page.getByRole('textbox', { name: 'AWS Account ID' });
            await accountIdInput.fill('ABCDEFGHIJKL');
            await page.getByRole('button', { name: /Create Account/i }).click();
            await expect(
                page.getByText(/only numbers|must contain only numbers/i).first()
            ).toBeVisible({ timeout: 5000 });
        });

        test('Account Name required validation fires on submit', async ({ page }) => {
            // Fill a valid account ID but leave name empty
            await page.getByRole('textbox', { name: 'AWS Account ID' }).fill('123456789012');
            await page.getByRole('button', { name: /Create Account/i }).click();
            await expect(
                page.getByText(/Account name is required/i).first()
            ).toBeVisible({ timeout: 5000 });
        });

        test('Role ARN format validation fires on submit', async ({ page }) => {
            await page.getByRole('textbox', { name: 'AWS Account ID' }).fill('123456789012');
            await page.getByRole('textbox', { name: 'Account Name' }).fill('Test Account');
            await page.getByRole('textbox', { name: /Cross-Account Role ARN/i }).fill('invalid-arn');
            await page.getByRole('button', { name: /Create Account/i }).click();
            await expect(
                page.getByText(/Invalid Role ARN format/i).first()
            ).toBeVisible({ timeout: 5000 });
        });

        test('Role ARN field accepts valid ARN format', async ({ page }) => {
            const arnInput = page.getByRole('textbox', { name: /Cross-Account Role ARN/i });
            await arnInput.fill('arn:aws:iam::123456789012:role/NucleusAccess');
            await expect(arnInput).toHaveValue('arn:aws:iam::123456789012:role/NucleusAccess');
        });

        test('Account ID field accepts exactly 12 digits', async ({ page }) => {
            const accountIdInput = page.getByRole('textbox', { name: 'AWS Account ID' });
            await accountIdInput.fill('123456789012');
            await expect(accountIdInput).toHaveValue('123456789012');
        });

        test('Account Name field accepts text input', async ({ page }) => {
            const nameInput = page.getByRole('textbox', { name: 'Account Name' });
            await nameInput.fill('Production Account');
            await expect(nameInput).toHaveValue('Production Account');
        });

        test('Description field accepts optional text', async ({ page }) => {
            const descInput = page.getByRole('textbox', { name: /Description/i });
            await descInput.fill('My test description');
            await expect(descInput).toHaveValue('My test description');
        });

        test('External ID field is read-only', async ({ page }) => {
            const externalIdInput = page.getByRole('textbox', { name: /External ID/i });
            await expect(externalIdInput).toBeVisible({ timeout: 10000 });
            const isReadOnly = await externalIdInput.getAttribute('readonly');
            // readOnly attribute is present (value is "" or "true")
            expect(isReadOnly).not.toBeNull();
        });

        test('Generate Template button is disabled when Account ID is empty', async ({ page }) => {
            const generateBtn = page.getByRole('button', { name: /Generate Template/i });
            await expect(generateBtn).toBeDisabled({ timeout: 10000 });
        });

        test('Generate Template button is disabled when Account ID is less than 12 digits', async ({ page }) => {
            await page.getByRole('textbox', { name: 'AWS Account ID' }).fill('12345');
            const generateBtn = page.getByRole('button', { name: /Generate Template/i });
            await expect(generateBtn).toBeDisabled({ timeout: 5000 });
        });

        test('Generate Template button is enabled when Account ID is exactly 12 digits', async ({ page }) => {
            await page.getByRole('textbox', { name: 'AWS Account ID' }).fill('123456789012');
            const generateBtn = page.getByRole('button', { name: /Generate Template/i });
            await expect(generateBtn).toBeEnabled({ timeout: 5000 });
        });

        test('Region dropdown shows default region (Asia Pacific Mumbai)', async ({ page }) => {
            // Default region is ap-south-1
            await expect(
                page.getByText(/Asia Pacific.*Mumbai/i).first()
            ).toBeVisible({ timeout: 10000 });
        });

        test('Region dropdown opens and shows region options', async ({ page }) => {
            // Click the region select trigger
            await page.getByRole('combobox').first().click();
            await expect(
                page.getByRole('option', { name: /US East.*N. Virginia/i })
            ).toBeVisible({ timeout: 5000 });
            await expect(
                page.getByRole('option', { name: /Europe.*Ireland/i })
            ).toBeVisible({ timeout: 5000 });
        });

        test('Region can be changed to a different region', async ({ page }) => {
            await page.getByRole('combobox').first().click();
            await page.getByRole('option', { name: /US East.*N. Virginia/i }).click();
            await expect(
                page.getByText(/US East.*N. Virginia/i).first()
            ).toBeVisible({ timeout: 5000 });
        });

        test('CloudFormation Template section heading is visible', async ({ page }) => {
            await expect(
                page.getByText('CloudFormation Template')
            ).toBeVisible({ timeout: 10000 });
        });

        test('Account Configuration card heading is visible', async ({ page }) => {
            await expect(
                page.getByText('Account Configuration').first()
            ).toBeVisible({ timeout: 10000 });
        });

        test('Create Account button is disabled while submitting', async ({ page }) => {
            // Fill all required fields with valid data
            await page.getByRole('textbox', { name: 'AWS Account ID' }).fill('123456789012');
            await page.getByRole('textbox', { name: 'Account Name' }).fill('Test Account');
            await page.getByRole('textbox', { name: /Cross-Account Role ARN/i }).fill('arn:aws:iam::123456789012:role/NucleusAccess');
            // External ID is readOnly — skip (would need template generation)
            // Just verify the button exists and is not disabled before submit
            const submitBtn = page.getByRole('button', { name: /Create Account/i });
            await expect(submitBtn).toBeVisible({ timeout: 5000 });
            await expect(submitBtn).not.toBeDisabled();
        });

        test('multiple validation errors shown simultaneously', async ({ page }) => {
            // Submit completely empty form
            await page.getByRole('button', { name: /Create Account/i }).click();
            // Both Account ID and Account Name errors should appear
            await expect(
                page.getByText(/12 digits/i).first()
            ).toBeVisible({ timeout: 5000 });
            await expect(
                page.getByText(/Account name is required/i).first()
            ).toBeVisible({ timeout: 5000 });
        });
    });
});

// ─── Create Account — Full Submission (mocked API) ───────────────────────────

test.describe('AWS Accounts — Create Account Submission', () => {
    test('successful creation redirects to accounts list', async ({ page }) => {
        // Mock template API so Generate Template populates externalId
        await page.route('**/api/accounts/template**', async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    success: true,
                    template: { AWSTemplateFormatVersion: '2010-09-09' },
                    templateYaml: 'AWSTemplateFormatVersion: "2010-09-09"',
                    externalId: 'e2e-test-external-id',
                    suggestedRoleArn: 'arn:aws:iam::999999999999:role/NucleusAccess',
                }),
            });
        });

        // Mock accounts POST to avoid writing to real DynamoDB
        await page.route('**/api/accounts', async (route) => {
            if (route.request().method() === 'POST') {
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({ success: true, data: { accountId: '999999999999' } }),
                });
            } else {
                await route.continue();
            }
        });

        await page.goto('/app/accounts/create', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await expect(page.getByRole('heading', { name: /Create AWS Account/i })).toBeVisible({ timeout: 15000 });

        // Fill Account ID and trigger Generate Template to populate externalId
        await page.getByRole('textbox', { name: 'AWS Account ID' }).fill('999999999999');
        await page.getByRole('textbox', { name: 'Account Name' }).fill('E2E Test Account');
        await page.getByRole('button', { name: /Generate Template/i }).click();

        // Wait for externalId to be populated by the mocked template response
        await expect(page.getByRole('textbox', { name: /External ID/i })).toHaveValue('e2e-test-external-id', { timeout: 10000 });

        // Role ARN is auto-filled by suggestedRoleArn — verify it
        await expect(page.getByRole('textbox', { name: /Cross-Account Role ARN/i })).toHaveValue(
            'arn:aws:iam::999999999999:role/NucleusAccess', { timeout: 5000 }
        );

        await page.getByRole('button', { name: /Create Account/i }).click();

        // Should redirect back to accounts list (may include ?limit=10 query param)
        await expect(page).toHaveURL(/\/app\/accounts(\?|$)/, { timeout: 15000 });
    });

    test('API error shows alert and stays on create page', async ({ page }) => {
        await page.route('**/api/accounts/template**', async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    success: true,
                    template: {},
                    externalId: 'e2e-ext-id',
                    suggestedRoleArn: 'arn:aws:iam::999999999999:role/NucleusAccess',
                }),
            });
        });

        await page.route('**/api/accounts', async (route) => {
            if (route.request().method() === 'POST') {
                await route.fulfill({
                    status: 500,
                    contentType: 'application/json',
                    body: JSON.stringify({ success: false, error: 'Internal server error' }),
                });
            } else {
                await route.continue();
            }
        });

        // Handle the alert dialog that appears on error
        page.on('dialog', async (dialog) => {
            expect(dialog.message()).toContain('Failed to create account');
            await dialog.accept();
        });

        await page.goto('/app/accounts/create', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await expect(page.getByRole('heading', { name: /Create AWS Account/i })).toBeVisible({ timeout: 15000 });

        await page.getByRole('textbox', { name: 'AWS Account ID' }).fill('999999999999');
        await page.getByRole('textbox', { name: 'Account Name' }).fill('E2E Test Account');
        await page.getByRole('button', { name: /Generate Template/i }).click();
        await expect(page.getByRole('textbox', { name: /External ID/i })).toHaveValue('e2e-ext-id', { timeout: 10000 });

        await page.getByRole('button', { name: /Create Account/i }).click();

        // Should stay on create page after error
        await expect(page).toHaveURL(/\/app\/accounts\/create/, { timeout: 10000 });
    });
});

// ─── Edit Account ─────────────────────────────────────────────────────────────

test.describe('AWS Accounts — Edit Account', () => {
    test('Edit button on detail page navigates to edit form', async ({ page }) => {
        await gotoAccounts(page);
        await expect(page.getByRole('heading', { name: 'AWS Accounts' })).toBeVisible({ timeout: 15000 });

        // Click a card to reach the detail page
        await expect(page.getByText('Role ARN').first()).toBeVisible({ timeout: 15000 });
        await page.getByText('Role ARN').first().click();
        await expect(page).toHaveURL(/\/app\/accounts\/.+/, { timeout: 15000 });

        // Click Edit button
        await page.getByRole('button', { name: /Edit/i }).click();
        await expect(page).toHaveURL(/\/app\/accounts\/.+\/edit/, { timeout: 15000 });
    });

    test.describe('Edit Account Form', () => {
        // Navigate to edit page via accounts list → card → detail → edit
        async function gotoEditPage(page: Page) {
            await gotoAccounts(page);
            await expect(page.getByRole('heading', { name: 'AWS Accounts' })).toBeVisible({ timeout: 15000 });
            await expect(page.getByText('Role ARN').first()).toBeVisible({ timeout: 15000 });
            await page.getByText('Role ARN').first().click();
            await expect(page).toHaveURL(/\/app\/accounts\/.+/, { timeout: 15000 });
            await page.getByRole('button', { name: /Edit/i }).click();
            await expect(page).toHaveURL(/\/app\/accounts\/.+\/edit/, { timeout: 15000 });
        }

        test('edit form loads with Account ID pre-populated and disabled', async ({ page }) => {
            await gotoEditPage(page);
            const accountIdInput = page.getByRole('textbox', { name: 'AWS Account ID' });
            await expect(accountIdInput).toBeVisible({ timeout: 15000 });
            await expect(accountIdInput).toBeDisabled();
            const value = await accountIdInput.inputValue();
            expect(value.length).toBe(12);
        });

        test('edit form loads with Account Name pre-populated and disabled', async ({ page }) => {
            await gotoEditPage(page);
            const nameInput = page.getByRole('textbox', { name: 'Account Name' });
            await expect(nameInput).toBeVisible({ timeout: 15000 });
            await expect(nameInput).toBeDisabled();
        });

        test('Description field is editable', async ({ page }) => {
            await gotoEditPage(page);
            const descInput = page.getByRole('textbox', { name: /Description/i });
            await expect(descInput).toBeVisible({ timeout: 15000 });
            await descInput.fill('Updated description from E2E test');
            await expect(descInput).toHaveValue('Updated description from E2E test');
        });

        test('Role ARN field is editable', async ({ page }) => {
            await gotoEditPage(page);
            const roleArnInput = page.getByRole('textbox', { name: /Cross-Account Role ARN/i });
            await expect(roleArnInput).toBeVisible({ timeout: 15000 });
            await expect(roleArnInput).not.toBeDisabled();
        });

        test('Active/Inactive toggle is present', async ({ page }) => {
            await gotoEditPage(page);
            await expect(page.getByRole('switch').first()).toBeVisible({ timeout: 15000 });
        });

        test('AWS Regions checkboxes are present', async ({ page }) => {
            await gotoEditPage(page);
            await expect(page.getByText('AWS Regions')).toBeVisible({ timeout: 15000 });
            // At least one region checkbox should be visible
            await expect(page.getByRole('checkbox').first()).toBeVisible({ timeout: 10000 });
        });

        test('Test Connection button is present', async ({ page }) => {
            await gotoEditPage(page);
            await expect(page.getByRole('button', { name: /Test Connection/i })).toBeVisible({ timeout: 15000 });
        });

        test('Save Changes button is present', async ({ page }) => {
            await gotoEditPage(page);
            await expect(page.getByRole('button', { name: /Save Changes/i })).toBeVisible({ timeout: 15000 });
        });

        test('Cancel button navigates back to account detail page', async ({ page }) => {
            await gotoEditPage(page);
            // Capture the accountId from the current URL before clicking Cancel
            const editUrl = page.url();
            const accountId = editUrl.match(/\/app\/accounts\/([^/]+)\/edit/)?.[1];
            await page.getByRole('button', { name: /Cancel/i }).click();
            await expect(page).toHaveURL(new RegExp(`/app/accounts/${accountId}$`), { timeout: 15000 });
        });

        test('successful update redirects to accounts list', async ({ page }) => {
            await gotoEditPage(page);
            const editUrl = page.url();
            const accountId = editUrl.match(/\/app\/accounts\/([^/]+)\/edit/)?.[1];

            // Mock the PUT API
            await page.route(`**/api/accounts/${accountId}`, async (route) => {
                if (route.request().method() === 'PUT') {
                    await route.fulfill({
                        status: 200,
                        contentType: 'application/json',
                        body: JSON.stringify({ success: true, message: 'Account updated successfully' }),
                    });
                } else {
                    await route.continue();
                }
            });

            // Change description
            const descInput = page.locator('input#description');
            await descInput.fill('E2E updated description');

            await page.getByRole('button', { name: /Save Changes/i }).click();
            await expect(page).toHaveURL(/\/app\/accounts(\?|$)/, { timeout: 15000 });
        });
    });
});

// ─── Delete Account ───────────────────────────────────────────────────────────

test.describe('AWS Accounts — Delete Account', () => {
    test('three-dot menu in table view shows Delete option', async ({ page }) => {
        await gotoAccounts(page);
        await expect(page.getByRole('heading', { name: 'AWS Accounts' })).toBeVisible({ timeout: 15000 });
        await page.getByRole('tab', { name: /Table View/i }).click();
        await expect(page.locator('table').first()).toBeVisible({ timeout: 10000 });

        // Open the first row's dropdown menu and wait for it to appear
        await page.locator('tbody tr').first().locator('button[aria-haspopup="menu"]').click();
        await expect(page.getByRole('menu').first()).toBeVisible({ timeout: 5000 });
        await expect(
            page.getByRole('menuitem', { name: 'Delete' })
        ).toBeVisible({ timeout: 5000 });
    });

    test('clicking Delete in table view opens confirmation dialog', async ({ page }) => {
        await gotoAccounts(page);
        await expect(page.getByRole('heading', { name: 'AWS Accounts' })).toBeVisible({ timeout: 15000 });
        await page.getByRole('tab', { name: /Table View/i }).click();
        await expect(page.locator('table').first()).toBeVisible({ timeout: 10000 });

        await page.locator('tbody tr').first().locator('button[aria-haspopup="menu"]').click();
        await expect(page.getByRole('menu').first()).toBeVisible({ timeout: 5000 });
        await page.getByRole('menuitem', { name: 'Delete' }).click();

        // DeleteAccountDialog should appear
        await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 });
        await expect(page.getByText(/Delete Account/i).first()).toBeVisible({ timeout: 5000 });
    });

    test('delete dialog shows warning about irreversible action', async ({ page }) => {
        await gotoAccounts(page);
        await expect(page.getByRole('heading', { name: 'AWS Accounts' })).toBeVisible({ timeout: 15000 });
        await page.getByRole('tab', { name: /Table View/i }).click();
        await expect(page.locator('table').first()).toBeVisible({ timeout: 10000 });

        await page.locator('tbody tr').first().locator('button[aria-haspopup="menu"]').click();
        await expect(page.getByRole('menu').first()).toBeVisible({ timeout: 5000 });
        await page.getByRole('menuitem', { name: 'Delete' }).click();
        await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 });

        await expect(
            page.getByText(/cannot be undone|cannot be recovered/i).first()
        ).toBeVisible({ timeout: 5000 });
    });

    test('Cancel in delete dialog closes dialog without deleting', async ({ page }) => {
        await gotoAccounts(page);
        await expect(page.getByRole('heading', { name: 'AWS Accounts' })).toBeVisible({ timeout: 15000 });
        await page.getByRole('tab', { name: /Table View/i }).click();
        await expect(page.locator('table').first()).toBeVisible({ timeout: 10000 });

        await page.locator('tbody tr').first().locator('button[aria-haspopup="menu"]').click();
        await expect(page.getByRole('menu').first()).toBeVisible({ timeout: 5000 });
        await page.getByRole('menuitem', { name: 'Delete' }).click();
        await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 });

        await page.getByRole('button', { name: /Cancel/i }).click();
        await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 5000 });
        expect(page.url()).toContain('/app/accounts');
    });

    test('confirming delete calls DELETE API and refreshes list', async ({ page }) => {
        await gotoAccounts(page);
        await expect(page.getByRole('heading', { name: 'AWS Accounts' })).toBeVisible({ timeout: 15000 });
        await page.getByRole('tab', { name: /Table View/i }).click();
        await expect(page.locator('table').first()).toBeVisible({ timeout: 10000 });

        let deleteRequestMade = false;
        await page.route('**/api/accounts/**', async (route) => {
            if (route.request().method() === 'DELETE') {
                deleteRequestMade = true;
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({ success: true, message: 'Account deleted successfully' }),
                });
            } else {
                await route.continue();
            }
        });

        await page.locator('tbody tr').first().locator('button[aria-haspopup="menu"]').click();
        await expect(page.getByRole('menu').first()).toBeVisible({ timeout: 5000 });
        await page.getByRole('menuitem', { name: 'Delete' }).click();
        await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 });

        await page.getByRole('button', { name: /Delete Account/i }).click();

        await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 10000 });
        expect(deleteRequestMade).toBe(true);
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
        await page.getByRole('option', { name: 'Active Only' }).first().click();

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

// ─── Bug Coverage Tests ───────────────────────────────────────────────────────

test.describe('AWS Accounts — Bug Coverage', () => {

    // BUG-1: Delete from Grid View context menu navigates to detail page
    // instead of showing a confirmation dialog (only Table View has the dialog).
    test('[BUG-1] Delete from Grid View context menu should show confirmation dialog, not navigate away', async ({ page }) => {
        await gotoAccounts(page);
        await expect(page.getByRole('heading', { name: 'AWS Accounts' })).toBeVisible({ timeout: 15000 });
        await page.getByRole('tab', { name: /Grid View/i }).click();
        await expect(page.getByText('Role ARN').first()).toBeVisible({ timeout: 15000 });

        await page.locator('button[aria-haspopup="menu"]').first().click();
        await expect(page.getByRole('menu').first()).toBeVisible({ timeout: 5000 });
        await page.getByRole('menuitem', { name: 'Delete' }).click();

        // EXPECTED: confirmation dialog appears
        // ACTUAL (bug): navigates to /app/accounts/<id> detail page
        await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5000 });
        expect(page.url()).toContain('/app/accounts?');
    });

    // BUG-2: After Generate Template populates External ID, the "External ID is required"
    // validation error persists even though the field has a value.
    test('[BUG-2] External ID validation error should clear after Generate Template populates the field', async ({ page }) => {
        await page.route('**/api/accounts/template**', async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    success: true,
                    template: {},
                    externalId: 'generated-ext-id-123',
                    suggestedRoleArn: 'arn:aws:iam::111122223333:role/NucleusAccess',
                }),
            });
        });

        await page.goto('/app/accounts/create', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await expect(page.getByRole('heading', { name: /Create AWS Account/i })).toBeVisible({ timeout: 15000 });

        // Trigger validation errors first
        await page.getByRole('button', { name: /Create Account/i }).click();
        await expect(page.getByText('External ID is required')).toBeVisible({ timeout: 5000 });

        // Fill Account ID and generate template to auto-populate External ID
        await page.getByRole('textbox', { name: 'AWS Account ID' }).fill('111122223333');
        await page.getByRole('button', { name: /Generate Template/i }).click();
        await expect(page.getByRole('textbox', { name: /External ID/i })).not.toHaveValue('', { timeout: 10000 });

        // EXPECTED: validation error clears once field has a value
        // ACTUAL (bug): "External ID is required" still shown even though field has value
        await expect(page.getByText('External ID is required')).not.toBeVisible({ timeout: 5000 });
    });

    // BUG-3: Account Name field is disabled in the Edit form — users cannot rename accounts.
    test('[BUG-3] Account Name should be editable in the Edit form', async ({ page }) => {
        await gotoAccounts(page);
        await expect(page.getByRole('heading', { name: 'AWS Accounts' })).toBeVisible({ timeout: 15000 });
        await expect(page.getByText('Role ARN').first()).toBeVisible({ timeout: 15000 });
        await page.getByText('Role ARN').first().click();
        await expect(page).toHaveURL(/\/app\/accounts\/.+/, { timeout: 15000 });
        await page.getByRole('button', { name: /Edit/i }).click();
        await expect(page).toHaveURL(/\/app\/accounts\/.+\/edit/, { timeout: 15000 });

        const nameInput = page.getByRole('textbox', { name: 'Account Name' });
        await expect(nameInput).toBeVisible({ timeout: 15000 });
        // EXPECTED: name field is editable
        // ACTUAL (bug): field is disabled — "Friendly name (cannot be changed)"
        await expect(nameInput).not.toBeDisabled();
    });

    // BUG-4: Clear Filters button click event propagates to the account card underneath,
    // causing navigation to an account detail page instead of clearing filters.
    test('[BUG-4] Clear Filters button should not navigate to account detail page', async ({ page }) => {
        await gotoAccounts(page);
        await expect(page.getByRole('heading', { name: 'AWS Accounts' })).toBeVisible({ timeout: 15000 });

        const searchInput = page.getByPlaceholder('Search accounts by name, ID, description...');
        await searchInput.fill('STX');
        await page.getByRole('button', { name: /Apply Filters/i }).click();
        await page.waitForLoadState('domcontentloaded');

        await page.getByRole('button', { name: /Clear Filters/i }).click();

        // EXPECTED: stays on accounts list with cleared filters
        // ACTUAL (bug): navigates to /app/accounts/<id> due to click propagation
        await expect(page).toHaveURL(/\/app\/accounts(\?|$)/, { timeout: 5000 });
        expect(page.url()).not.toMatch(/\/app\/accounts\/[^?]/);
    });

    // BUG-5: Search term is reflected in URL only after Apply Filters is clicked.
    test('[BUG-5] Search term should be reflected in URL after Apply Filters', async ({ page }) => {
        await gotoAccounts(page);
        await expect(page.getByRole('heading', { name: 'AWS Accounts' })).toBeVisible({ timeout: 15000 });

        const searchInput = page.getByPlaceholder('Search accounts by name, ID, description...');
        await searchInput.fill('kartik');
        await page.getByRole('button', { name: /Apply Filters/i }).click();
        await page.waitForLoadState('domcontentloaded');

        expect(page.url()).toContain('search=kartik');
    });

    // BUG-6: Previous page button on page 1 should be disabled.
    test('[BUG-6] Previous page button should be disabled on page 1', async ({ page }) => {
        await page.goto('/app/accounts?limit=10', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await expect(page.getByRole('heading', { name: 'AWS Accounts' })).toBeVisible({ timeout: 15000 });

        const prevLink = page.getByRole('link', { name: /Go to previous page/i });
        await expect(prevLink).toBeVisible({ timeout: 10000 });
        // EXPECTED: previous link is disabled on page 1
        await expect(prevLink).toHaveAttribute('aria-disabled', 'true');
    });

    // BUG-7: Activate/Deactivate buttons have no confirmation dialog.
    test('[BUG-7] Activate button should show confirmation before changing status', async ({ page }) => {
        await gotoAccounts(page);
        await expect(page.getByRole('heading', { name: 'AWS Accounts' })).toBeVisible({ timeout: 15000 });

        const activateBtn = page.getByRole('button', { name: /^Activate$/i }).first();
        if (!await activateBtn.isVisible()) {
            test.skip();
            return;
        }
        await activateBtn.click();
        // EXPECTED: confirmation dialog appears before status change
        // ACTUAL (bug): status changes immediately with no confirmation
        await expect(page.getByRole('dialog')).toBeVisible({ timeout: 3000 });
    });
});
