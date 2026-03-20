import { Page, Locator, expect } from '@playwright/test';

export class InventoryPage {
    readonly page: Page;

    // Header buttons
    readonly syncNowBtn: Locator;
    readonly exportBtn: Locator;
    readonly askAIBtn: Locator;

    // Filters
    readonly searchInput: Locator;
    readonly clearFiltersBtn: Locator;

    // Table
    readonly resourcesHeading: Locator;
    readonly resourceRows: Locator;
    readonly emptyState: Locator;

    // Pagination
    readonly nextPageBtn: Locator;
    readonly firstPageBtn: Locator;

    constructor(page: Page) {
        this.page = page;

        this.syncNowBtn = page.getByRole('button', { name: 'Sync Now' });
        this.exportBtn = page.getByRole('button', { name: 'Export' });
        this.askAIBtn = page.getByRole('button', { name: 'Ask AI' });

        this.searchInput = page.getByPlaceholder('Search by name or ID...');
        this.clearFiltersBtn = page.getByRole('button', { name: 'Clear Filters' });

        // CardTitle renders as <div>, not <h3> — use text locator
        this.resourcesHeading = page.getByText('Discovered Resources', { exact: true });
        this.resourceRows = page.locator('table tbody tr');
        this.emptyState = page.getByText('No resources found');

        // Use exact match to avoid matching "Open Next.js Dev Tools" button
        this.nextPageBtn = page.getByRole('button', { name: 'Next', exact: true });
        this.firstPageBtn = page.getByRole('button', { name: 'First', exact: true });
    }

    async goto() {
        await this.page.goto('/inventory');
        await this.page.waitForLoadState('networkidle');
    }

    async waitForResourcesLoaded() {
        // Wait until the loading spinner is gone
        await this.page.waitForSelector('[class*="animate-spin"]', { state: 'detached', timeout: 15000 }).catch(() => {});
        await this.page.waitForLoadState('networkidle');
    }

    async selectResourceType(label: string) {
        // Resource type is the first combobox (index 0)
        const trigger = this.page.locator('[role="combobox"]').nth(0);
        await trigger.click();
        await this.page.getByRole('option', { name: label, exact: true }).click();
        await this.waitForResourcesLoaded();
    }

    async selectRegion(label: string) {
        // Region is the second combobox (index 1)
        const trigger = this.page.locator('[role="combobox"]').nth(1);
        await trigger.click();
        await this.page.getByRole('option', { name: label, exact: true }).click();
        await this.waitForResourcesLoaded();
    }

    async selectAccount(nameOrId: string) {
        // Account filter is a Popover combobox
        const accountBtn = this.page.locator('button[role="combobox"]').filter({ hasText: /All Accounts/ });
        await accountBtn.click();
        const searchInput = this.page.getByPlaceholder('Search account...');
        await expect(searchInput).toBeVisible({ timeout: 5000 });
        await searchInput.fill(nameOrId);
        await this.page.getByRole('option', { name: new RegExp(nameOrId, 'i') }).first().click();
        await this.waitForResourcesLoaded();
    }

    async search(term: string) {
        await this.searchInput.fill(term);
        await this.waitForResourcesLoaded();
    }

    async clearFilters() {
        await this.clearFiltersBtn.click();
        await this.waitForResourcesLoaded();
    }

    async getStatValue(cardTitle: string): Promise<string> {
        // Use exact: true to avoid matching ancestor elements that also contain the text
        // CardTitle (div) → CardHeader (div) → Card (div)
        // getByText returns the CardTitle div, so ../.. is the Card
        const titleEl = this.page.getByText(cardTitle, { exact: true });
        const card = titleEl.locator('../..');
        const value = card.locator('.text-2xl.font-bold').first();
        return (await value.textContent())?.trim() ?? '';
    }

    async getResourceCount(): Promise<number> {
        const text = await this.page.getByText(/Showing \d+ resources/).first().textContent();
        const match = text?.match(/Showing (\d+) resources/);
        return match ? parseInt(match[1]) : 0;
    }

    async clickFirstRow() {
        await this.resourceRows.first().click();
        await this.page.waitForSelector('[role="dialog"]');
    }
}
