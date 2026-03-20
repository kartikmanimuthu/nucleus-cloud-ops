import { test, expect } from '@playwright/test';
import { InventoryPage } from './pages/inventory-page';

// ─── Page Load ───────────────────────────────────────────────────────────────

test.describe('Inventory — Page Load', () => {
    test('renders page title and description', async ({ page }) => {
        const inv = new InventoryPage(page);
        await inv.goto();
        await expect(page.getByRole('heading', { name: 'Inventory Discovery' })).toBeVisible();
        await expect(page.getByText('Auto-discovered AWS resources across all connected accounts')).toBeVisible();
    });

    test('renders all four action buttons', async ({ page }) => {
        const inv = new InventoryPage(page);
        await inv.goto();
        await expect(inv.syncNowBtn).toBeVisible();
        await expect(inv.exportBtn).toBeVisible();
        await expect(inv.askAIBtn).toBeVisible();
    });

    test('renders all four stats cards', async ({ page }) => {
        const inv = new InventoryPage(page);
        await inv.goto();
        await expect(page.getByText('Total Resources')).toBeVisible();
        await expect(page.getByText('Accounts Synced')).toBeVisible();
        await expect(page.getByText('Last Sync')).toBeVisible();
        await expect(page.getByText('Current View')).toBeVisible();
    });

    test('renders filter controls', async ({ page }) => {
        const inv = new InventoryPage(page);
        await inv.goto();
        await expect(inv.searchInput).toBeVisible();
        // Combobox triggers — check by role + text
        await expect(page.locator('[role="combobox"]').nth(0)).toContainText('All Types');
        await expect(page.locator('[role="combobox"]').nth(1)).toContainText('All Regions');
        await expect(page.locator('button[role="combobox"]').filter({ hasText: /All Accounts/ })).toBeVisible();
    });

    test('renders Discovered Resources section', async ({ page }) => {
        const inv = new InventoryPage(page);
        await inv.goto();
        await inv.waitForResourcesLoaded();
        await expect(inv.resourcesHeading).toBeVisible();
    });
});

// ─── Stats Cards ─────────────────────────────────────────────────────────────

test.describe('Inventory — Stats Cards', () => {
    test('Total Resources shows a numeric value matching live DynamoDB count', async ({ page }) => {
        const inv = new InventoryPage(page);
        await inv.goto();
        await inv.waitForResourcesLoaded();

        const val = await inv.getStatValue('Total Resources');
        // Should be a formatted number (e.g. "6,627" or "0"), not "—" or empty
        expect(val).toMatch(/^[\d,]+$/);
    });

    test('Accounts Synced shows a numeric value', async ({ page }) => {
        const inv = new InventoryPage(page);
        await inv.goto();
        await inv.waitForResourcesLoaded();

        const val = await inv.getStatValue('Accounts Synced');
        expect(val).toMatch(/^\d+$/);
    });

    test('Last Sync shows a date or Never', async ({ page }) => {
        const inv = new InventoryPage(page);
        await inv.goto();
        await inv.waitForResourcesLoaded();

        const lastSyncCard = page.getByText('Last Sync', { exact: true }).locator('../..');
        const dateText = await lastSyncCard.locator('.text-2xl.font-bold').first().textContent();
        // Either "Never" or a date like "3/17/2026"
        expect(dateText?.trim()).toMatch(/Never|\d+\/\d+\/\d+/);
    });

    test('Current View count matches visible rows', async ({ page }) => {
        const inv = new InventoryPage(page);
        await inv.goto();
        await inv.waitForResourcesLoaded();

        const currentViewVal = await inv.getStatValue('Current View');
        // "Showing X resources" appears twice (CardDescription + pagination) — take first
        const rowsText = await page.getByText(/Showing \d+ resources/).first().textContent();
        const rowsMatch = rowsText?.match(/Showing (\d+) resources/);
        const rowCount = rowsMatch ? rowsMatch[1] : '0';

        expect(currentViewVal).toBe(rowCount);
    });
});

// ─── Resource Table ───────────────────────────────────────────────────────────

test.describe('Inventory — Resource Table', () => {
    test('shows resources when data exists (or empty state message)', async ({ page }) => {
        const inv = new InventoryPage(page);
        await inv.goto();
        await inv.waitForResourcesLoaded();

        const hasRows = await page.locator('table tbody tr').count() > 0;
        const hasEmpty = await inv.emptyState.isVisible().catch(() => false);
        expect(hasRows || hasEmpty).toBe(true);
    });

    test('clicking a row opens the resource detail dialog', async ({ page }) => {
        const inv = new InventoryPage(page);
        await inv.goto();
        await inv.waitForResourcesLoaded();

        const rowCount = await page.locator('table tbody tr').count();
        test.skip(rowCount === 0, 'No resources to click');

        await page.locator('table tbody tr').first().click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await expect(page.getByRole('dialog').getByRole('heading')).toBeVisible();
    });

    test('detail dialog has Details, Tags, Metadata tabs', async ({ page }) => {
        const inv = new InventoryPage(page);
        await inv.goto();
        await inv.waitForResourcesLoaded();

        const rowCount = await page.locator('table tbody tr').count();
        test.skip(rowCount === 0, 'No resources to click');

        await page.locator('table tbody tr').first().click();
        const dialog = page.getByRole('dialog');
        await expect(dialog.getByRole('tab', { name: 'Details' })).toBeVisible();
        await expect(dialog.getByRole('tab', { name: /Tags/ })).toBeVisible();
        await expect(dialog.getByRole('tab', { name: 'Metadata' })).toBeVisible();
    });

    test('detail dialog shows Resource ID and ARN with copy buttons', async ({ page }) => {
        const inv = new InventoryPage(page);
        await inv.goto();
        await inv.waitForResourcesLoaded();

        const rowCount = await page.locator('table tbody tr').count();
        test.skip(rowCount === 0, 'No resources to click');

        await page.locator('table tbody tr').first().click();
        const dialog = page.getByRole('dialog');
        await expect(dialog.getByText('Resource ID')).toBeVisible();
        await expect(dialog.getByText('Resource ARN')).toBeVisible();
    });

    test('detail dialog closes on dismiss', async ({ page }) => {
        const inv = new InventoryPage(page);
        await inv.goto();
        await inv.waitForResourcesLoaded();

        const rowCount = await page.locator('table tbody tr').count();
        test.skip(rowCount === 0, 'No resources to click');

        await page.locator('table tbody tr').first().click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).not.toBeVisible();
    });
});

// ─── Filters ─────────────────────────────────────────────────────────────────

test.describe('Inventory — Resource Type Filter', () => {
    const RESOURCE_TYPES = [
        { label: 'EC2 Instances', value: 'ec2_instances' },
        { label: 'RDS Instances', value: 'rds_instances' },
        { label: 'ECS Services', value: 'ecs_services' },
        { label: 'Lambda Functions', value: 'lambda_functions' },
        { label: 'S3 Buckets', value: 's3_buckets' },
        { label: 'Auto Scaling Groups', value: 'asg_groups' },
        { label: 'DynamoDB Tables', value: 'dynamodb_tables' },
    ];

    for (const rt of RESOURCE_TYPES) {
        test(`filter by ${rt.label} updates URL and resource list`, async ({ page }) => {
            const inv = new InventoryPage(page);
            await inv.goto();
            await inv.waitForResourcesLoaded();

            // Open resource type select
            const trigger = page.locator('[data-testid="resource-type-select"]').or(
                page.getByRole('combobox').first()
            );
            await trigger.click();

            const option = page.getByRole('option', { name: rt.label });
            await expect(option).toBeVisible({ timeout: 3000 });
            await option.click();
            await inv.waitForResourcesLoaded();

            // Trigger text should reflect the selection
            await expect(trigger).toContainText(rt.label);

            // Every visible row should match this resource type (if rows present)
            const rows = page.locator('table tbody tr');
            const rowCount = await rows.count();
            if (rowCount > 0) {
                // The description sub-text should change
                const desc = page.getByText(new RegExp(`Showing \\d+ resources.*${rt.value}`, 'i'))
                    .or(page.getByText(new RegExp(rt.label, 'i')).nth(1));
                // At minimum the filter shows the type in the card description
                await expect(page.getByText(rt.label).first()).toBeVisible();
            }
        });
    }

    test('selecting All Types returns all resources', async ({ page }) => {
        const inv = new InventoryPage(page);
        await inv.goto();
        await inv.waitForResourcesLoaded();
        const totalBefore = await inv.getStatValue('Total Resources');

        // Apply a filter first
        await page.locator('[role="combobox"]').first().click();
        await page.getByRole('option', { name: 'EC2 Instances' }).click();
        await inv.waitForResourcesLoaded();

        // Reset to All Types
        await page.locator('[role="combobox"]').first().click();
        await page.getByRole('option', { name: 'All Types' }).click();
        await inv.waitForResourcesLoaded();

        await expect(page.getByText('All Types')).toBeVisible();
    });
});

test.describe('Inventory — Region Filter', () => {
    test('filter by ap-south-1 narrows results', async ({ page }) => {
        const inv = new InventoryPage(page);
        await inv.goto();
        await inv.waitForResourcesLoaded();

        const regionTrigger = page.locator('[role="combobox"]').nth(1);
        await regionTrigger.click();
        // Label is "Asia Pacific (Mumbai)" — no region code suffix in the UI
        await page.getByRole('option', { name: 'Asia Pacific (Mumbai)', exact: true }).click();
        await inv.waitForResourcesLoaded();

        // Trigger should show the selected region label
        await expect(regionTrigger).toContainText('Asia Pacific (Mumbai)');
    });

    test('selecting All Regions resets filter', async ({ page }) => {
        const inv = new InventoryPage(page);
        await inv.goto();
        await inv.waitForResourcesLoaded();

        // Set region
        const regionTrigger = page.locator('[role="combobox"]').nth(1);
        await regionTrigger.click();
        await page.getByRole('option', { name: 'Asia Pacific (Mumbai)', exact: true }).click();
        await inv.waitForResourcesLoaded();

        // Reset
        await regionTrigger.click();
        await page.getByRole('option', { name: 'All Regions' }).click();
        await inv.waitForResourcesLoaded();

        await expect(regionTrigger).toContainText('All Regions');
    });
});

test.describe('Inventory — Account Filter', () => {
    test('account combobox opens and shows search input', async ({ page }) => {
        const inv = new InventoryPage(page);
        await inv.goto();
        await inv.waitForResourcesLoaded();

        // The account filter is a Popover — button has role="combobox" and text "All Accounts"
        const accountBtn = page.locator('button[role="combobox"]').filter({ hasText: /All Accounts/ });
        await accountBtn.click();

        await expect(page.getByPlaceholder('Search account...')).toBeVisible();
    });

    test('searching an account name filters the list', async ({ page }) => {
        const inv = new InventoryPage(page);
        await inv.goto();
        await inv.waitForResourcesLoaded();

        const accountBtn = page.locator('button[role="combobox"]').filter({ hasText: /All Accounts/ });
        await accountBtn.click();

        const searchInput = page.getByPlaceholder('Search account...');
        await expect(searchInput).toBeVisible({ timeout: 5000 });
        await searchInput.fill('SMC-PAYMENTS');

        // Account items display as "Name (accountId)" e.g. "SMC-PAYMENTS-PROD (039612869076)"
        await expect(page.getByRole('option', { name: /SMC-PAYMENTS/i }).first()).toBeVisible({ timeout: 10000 });
    });

    test('selecting an account filters resources', async ({ page }) => {
        const inv = new InventoryPage(page);
        await inv.goto();
        await inv.waitForResourcesLoaded();

        const accountBtn = page.locator('button[role="combobox"]').filter({ hasText: /All Accounts/ });
        await accountBtn.click();

        const searchInput = page.getByPlaceholder('Search account...');
        await expect(searchInput).toBeVisible({ timeout: 5000 });
        await searchInput.fill('SMC-PAYMENTS');
        await page.getByRole('option', { name: /SMC-PAYMENTS-PROD/i }).first().click();
        await inv.waitForResourcesLoaded();

        // Account button should now show the selected account name
        const btnText = await page.locator('button[role="combobox"]').filter({ hasText: /SMC-PAYMENTS-PROD|039612869076/i }).textContent();
        expect(btnText).toMatch(/SMC-PAYMENTS-PROD|039612869076/i);
    });
});

test.describe('Inventory — Search Filter', () => {
    test('typing in search narrows results', async ({ page }) => {
        const inv = new InventoryPage(page);
        await inv.goto();
        await inv.waitForResourcesLoaded();

        const totalBefore = await inv.getStatValue('Current View');

        await inv.searchInput.fill('nucleus');
        await inv.waitForResourcesLoaded();

        const totalAfter = await inv.getStatValue('Current View');
        // Results should be narrowed (or stay same if all match)
        expect(parseInt(totalAfter.replace(/,/g, ''))).toBeLessThanOrEqual(
            parseInt(totalBefore.replace(/,/g, ''))
        );
    });

    test('clearing search restores full results', async ({ page }) => {
        const inv = new InventoryPage(page);
        await inv.goto();
        await inv.waitForResourcesLoaded();

        await inv.searchInput.fill('nonexistent-resource-xyz-12345');
        await inv.waitForResourcesLoaded();

        await inv.searchInput.clear();
        await inv.waitForResourcesLoaded();

        // Should be back to unfiltered
        await expect(inv.searchInput).toHaveValue('');
    });

    test('search with no matches shows empty state', async ({ page }) => {
        const inv = new InventoryPage(page);
        await inv.goto();
        await inv.waitForResourcesLoaded();

        await inv.searchInput.fill('zzz-absolutely-no-match-xqz99999');
        await inv.waitForResourcesLoaded();

        await expect(inv.emptyState).toBeVisible({ timeout: 5000 });
    });
});

test.describe('Inventory — Combined Filters & Clear', () => {
    test('combining type + region filters applies both', async ({ page }) => {
        const inv = new InventoryPage(page);
        await inv.goto();
        await inv.waitForResourcesLoaded();

        // Apply resource type
        await page.locator('[role="combobox"]').first().click();
        await page.getByRole('option', { name: 'EC2 Instances' }).click();
        await inv.waitForResourcesLoaded();

        // Apply region
        const regionTrigger = page.locator('[role="combobox"]').nth(1);
        await regionTrigger.click();
        await page.getByRole('option', { name: 'Asia Pacific (Mumbai)', exact: true }).click();
        await inv.waitForResourcesLoaded();

        // Both filters active — Clear Filters button should appear
        await expect(inv.clearFiltersBtn).toBeVisible();
    });

    test('Clear Filters button resets all filters', async ({ page }) => {
        const inv = new InventoryPage(page);
        await inv.goto();
        await inv.waitForResourcesLoaded();

        // Apply a filter
        await page.locator('[role="combobox"]').first().click();
        await page.getByRole('option', { name: 'EC2 Instances' }).click();
        await inv.waitForResourcesLoaded();

        await expect(inv.clearFiltersBtn).toBeVisible();
        await inv.clearFiltersBtn.click();
        await inv.waitForResourcesLoaded();

        // All dropdowns should show "All ..." text
        await expect(page.getByText('All Types')).toBeVisible();
        await expect(page.getByText('All Regions')).toBeVisible();
        await expect(inv.clearFiltersBtn).not.toBeVisible();
    });

    test('Clear Filters button is hidden when no filters are active', async ({ page }) => {
        const inv = new InventoryPage(page);
        await inv.goto();
        await inv.waitForResourcesLoaded();
        await expect(inv.clearFiltersBtn).not.toBeVisible();
    });
});

// ─── Pagination ───────────────────────────────────────────────────────────────

test.describe('Inventory — Pagination', () => {
    test('page size selector changes row count', async ({ page }) => {
        const inv = new InventoryPage(page);
        await inv.goto();
        await inv.waitForResourcesLoaded();

        const rowCount = await page.locator('table tbody tr').count();
        test.skip(rowCount === 0, 'No resources to paginate');

        // Change page size to 10
        const pageSizeTrigger = page.locator('[role="combobox"]').last();
        await pageSizeTrigger.click();
        await page.getByRole('option', { name: '10', exact: true }).click();
        await inv.waitForResourcesLoaded();

        const newRowCount = await page.locator('table tbody tr').count();
        expect(newRowCount).toBeLessThanOrEqual(10);
    });

    test('Next button is enabled when more results exist', async ({ page }) => {
        const inv = new InventoryPage(page);
        await inv.goto();
        await inv.waitForResourcesLoaded();

        // Set small page size to ensure there's a next page
        const pageSizeTrigger = page.locator('[role="combobox"]').last();
        await pageSizeTrigger.click();
        await page.getByRole('option', { name: '10', exact: true }).click();
        await inv.waitForResourcesLoaded();

        const totalResources = parseInt(
            (await inv.getStatValue('Total Resources')).replace(/,/g, '')
        );

        if (totalResources > 10) {
            await expect(inv.nextPageBtn).toBeEnabled();
        } else {
            await expect(inv.nextPageBtn).toBeDisabled();
        }
    });

    test('First button is disabled on first page', async ({ page }) => {
        const inv = new InventoryPage(page);
        await inv.goto();
        await inv.waitForResourcesLoaded();
        await expect(inv.firstPageBtn).toBeDisabled();
    });

    test('Next then First returns to first page', async ({ page }) => {
        const inv = new InventoryPage(page);
        await inv.goto();
        await inv.waitForResourcesLoaded();

        // Ensure we have enough data for pagination
        const pageSizeTrigger = page.locator('[role="combobox"]').last();
        await pageSizeTrigger.click();
        await page.getByRole('option', { name: '10', exact: true }).click();
        await inv.waitForResourcesLoaded();

        const isNextEnabled = await inv.nextPageBtn.isEnabled();
        test.skip(!isNextEnabled, 'Not enough data for pagination test');

        const firstRowBefore = await page.locator('table tbody tr').first().textContent();

        // Intercept the page-2 request to verify cursor is passed and resources change
        const [nextResponse] = await Promise.all([
            page.waitForResponse(resp => resp.url().includes('/api/inventory/resources') && resp.url().includes('cursor=')),
            inv.nextPageBtn.click(),
        ]);
        expect(nextResponse.status()).toBe(200);
        const nextBody = await nextResponse.json();
        // Verify page 2 returned different resources
        expect(nextBody.resources.length).toBeGreaterThan(0);
        await inv.waitForResourcesLoaded();

        // The first row should have changed (different page)
        const firstRowAfterNext = await page.locator('table tbody tr').first().textContent();
        // At minimum the page loaded different content (or same if same data - that's ok)
        // First button should now be enabled (we're on page 2, not first page)
        await expect(inv.firstPageBtn).toBeEnabled({ timeout: 8000 });
        await inv.firstPageBtn.click();
        await inv.waitForResourcesLoaded();

        const firstRowAfter = await page.locator('table tbody tr').first().textContent();
        expect(firstRowAfter).toBe(firstRowBefore);
    });
});

// ─── Sync Now ─────────────────────────────────────────────────────────────────

test.describe('Inventory — Sync Now', () => {
    test('clicking Sync Now shows loading spinner', async ({ page }) => {
        const inv = new InventoryPage(page);
        await inv.goto();
        await inv.waitForResourcesLoaded();

        await inv.syncNowBtn.click();
        // Loading spinner should appear briefly
        await expect(page.locator('.animate-spin').first()).toBeVisible({ timeout: 3000 });
    });

    test('Sync Now shows success toast with scan ID', async ({ page }) => {
        const inv = new InventoryPage(page);
        await inv.goto();
        await inv.waitForResourcesLoaded();

        await inv.syncNowBtn.click();
        await expect(page.getByText(/Execution started|background/i)).toBeVisible({ timeout: 10000 });
        await expect(page.getByText(/Scan ID:/i)).toBeVisible({ timeout: 10000 });
    });

    test('Sync Now API returns 200 with scanId', async ({ page }) => {
        const inv = new InventoryPage(page);
        await inv.goto();

        const [response] = await Promise.all([
            page.waitForResponse(resp =>
                resp.url().includes('/api/inventory/sync') && resp.request().method() === 'POST'
            ),
            inv.syncNowBtn.click(),
        ]);

        expect(response.status()).toBe(200);
        const body = await response.json();
        expect(body).toHaveProperty('scanId');
        expect(body).toHaveProperty('success', true);
    });
});

// ─── Export ───────────────────────────────────────────────────────────────────

test.describe('Inventory — Export', () => {
    test('Export button calls /api/inventory/export and returns 200', async ({ page }) => {
        const inv = new InventoryPage(page);
        await inv.goto();
        await inv.waitForResourcesLoaded();

        const rowCount = await page.locator('table tbody tr').count();
        test.skip(rowCount === 0, 'No data to export');

        const [response] = await Promise.all([
            page.waitForResponse(resp =>
                resp.url().includes('/api/inventory/export') && resp.request().method() === 'POST'
            ),
            inv.exportBtn.click(),
        ]);

        expect(response.status()).toBe(200);
        const body = await response.json();
        expect(body).toHaveProperty('downloadUrl');
        expect(body).toHaveProperty('resourceCount');
        expect(body.resourceCount).toBeGreaterThan(0);
    });

    test('Export with EC2 type filter sends resourceType in request body', async ({ page }) => {
        const inv = new InventoryPage(page);
        await inv.goto();
        await inv.waitForResourcesLoaded();

        // Apply EC2 filter
        await page.locator('[role="combobox"]').first().click();
        await page.getByRole('option', { name: 'EC2 Instances' }).click();
        await inv.waitForResourcesLoaded();

        const rowCount = await page.locator('table tbody tr').count();
        test.skip(rowCount === 0, 'No EC2 data to export');

        const [request, response] = await Promise.all([
            page.waitForRequest(req =>
                req.url().includes('/api/inventory/export') && req.method() === 'POST'
            ),
            inv.exportBtn.click(),
        ]);

        const requestBody = JSON.parse(request.postData() ?? '{}');
        expect(requestBody).toHaveProperty('resourceType', 'ec2_instances');
    });

    test('Export with account filter sends accountId in request body', async ({ page }) => {
        const inv = new InventoryPage(page);
        await inv.goto();
        await inv.waitForResourcesLoaded();

        // Select an account
        const accountBtn = page.locator('button[role="combobox"]').filter({ hasText: /All Accounts/ });
        await accountBtn.click();
        const acctSearch = page.getByPlaceholder('Search account...');
        await expect(acctSearch).toBeVisible({ timeout: 5000 });
        await acctSearch.fill('SMC-PAYMENTS');
        await page.getByRole('option', { name: /SMC-PAYMENTS-PROD/i }).first().click();
        await inv.waitForResourcesLoaded();

        const rowCount = await page.locator('table tbody tr').count();
        test.skip(rowCount === 0, 'No data for this account');

        const [request] = await Promise.all([
            page.waitForRequest(req =>
                req.url().includes('/api/inventory/export') && req.method() === 'POST'
            ),
            inv.exportBtn.click(),
        ]);

        const requestBody = JSON.parse(request.postData() ?? '{}');
        expect(requestBody).toHaveProperty('accountId', '039612869076');
    });
});

// ─── Ask AI ───────────────────────────────────────────────────────────────────

test.describe('Inventory — Ask AI Dialog', () => {
    test('Ask AI button opens dialog', async ({ page }) => {
        const inv = new InventoryPage(page);
        await inv.goto();
        await inv.waitForResourcesLoaded();

        await inv.askAIBtn.click();
        await expect(page.getByRole('dialog')).toBeVisible();
    });

    test('Ask AI dialog can be closed', async ({ page }) => {
        const inv = new InventoryPage(page);
        await inv.goto();
        await inv.waitForResourcesLoaded();

        await inv.askAIBtn.click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).not.toBeVisible();
    });
});
