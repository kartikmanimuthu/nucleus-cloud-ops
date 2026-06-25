/**
 * Agent Chat E2E tests — /app/agent
 *
 * Covers:
 *  - Page load: chat input and send button visible
 *  - Sending a message and receiving a streamed AI response
 *  - Thread history persistence: messages reload after page refresh via thread sidebar
 *  - Thread list: sidebar shows previous conversations and loads messages on click
 *
 * Requires: dev server running with USE_PG_LANGGRAPH=true and valid AWS credentials.
 * Run: cd apps/web-ui-e2e && bunx playwright test agent-chat.spec.ts
 */
import { test, expect, Page } from '@playwright/test';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function gotoAgentChat(page: Page) {
    const res = await page.goto('/app/agent', { waitUntil: 'domcontentloaded', timeout: 60000 });
    expect(res?.status(), 'agent page should not 404').not.toBe(404);
    const body = await page.locator('body').innerText().catch(() => '');
    expect(body, 'agent page should not show 404 message').not.toMatch(/This page could not be found/i);
    expect(page.url(), 'agent page should not redirect to login').not.toContain('/login');
}

async function openThreadSidebar(page: Page) {
    const historyBtn = page.getByRole('button', { name: /chat history/i });
    await expect(historyBtn).toBeVisible({ timeout: 10000 });
    await historyBtn.click();
}

// ─── Page Load ───────────────────────────────────────────────────────────────

test.describe('Agent Chat — Page Load', () => {
    test.beforeEach(async ({ page }) => {
        await gotoAgentChat(page);
    });

    test('chat input field is visible', async ({ page }) => {
        await expect(
            page.getByTestId('chat-input')
        ).toBeVisible({ timeout: 15000 });
    });

    test('send button is visible', async ({ page }) => {
        await expect(
            page.getByTestId('chat-send-button')
        ).toBeVisible({ timeout: 10000 });
    });

    test('empty state prompt is shown when no messages', async ({ page }) => {
        await expect(
            page.getByText('Start a Conversation')
        ).toBeVisible({ timeout: 10000 });
    });
});

// ─── Send Message ─────────────────────────────────────────────────────────────

test.describe('Agent Chat — Send Message', () => {
    test.beforeEach(async ({ page }) => {
        await gotoAgentChat(page);
        await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 15000 });
    });

    test('user message appears in chat after sending', async ({ page }) => {
        const input = page.getByTestId('chat-input');
        await input.fill('Hello, this is a test message');
        await page.getByTestId('chat-send-button').click();

        // User message should appear immediately
        await expect(
            page.getByTestId('user-message').first()
        ).toBeVisible({ timeout: 10000 });

        await expect(
            page.getByTestId('user-message').first()
        ).toContainText('Hello, this is a test message');
    });

    test('AI response appears after sending a message', async ({ page }) => {
        const input = page.getByTestId('chat-input');
        await input.fill('Say "pong" and nothing else.');
        await page.getByTestId('chat-send-button').click();

        // Wait for user message to appear
        await expect(page.getByTestId('user-message').first()).toBeVisible({ timeout: 10000 });

        // Wait for AI response — agent may take time; use a generous timeout
        await expect(
            page.getByTestId('ai-message').first()
        ).toBeVisible({ timeout: 120000 });
    });

    test('send button is disabled when input is empty', async ({ page }) => {
        const sendBtn = page.getByTestId('chat-send-button');
        // Input is empty by default — button should be disabled
        await expect(sendBtn).toBeDisabled({ timeout: 5000 });
    });

    test('send button becomes enabled when input has text', async ({ page }) => {
        const input = page.getByTestId('chat-input');
        await input.fill('test');
        await expect(page.getByTestId('chat-send-button')).toBeEnabled({ timeout: 5000 });
    });
});

// ─── Thread History Persistence ───────────────────────────────────────────────

test.describe('Agent Chat — Thread History Persistence', () => {
    test('thread appears in sidebar after sending a message', async ({ page }) => {
        await gotoAgentChat(page);
        await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 15000 });

        // Send a message to create a thread
        await page.getByTestId('chat-input').fill('Thread persistence test message');
        await page.getByTestId('chat-send-button').click();

        // Wait for user message to appear (thread is now created)
        await expect(page.getByTestId('user-message').first()).toBeVisible({ timeout: 10000 });

        // Open thread sidebar and verify the thread appears
        await openThreadSidebar(page);

        // Thread sidebar should show at least one thread
        const threadList = page.locator('[data-testid="thread-sidebar"], .thread-sidebar, [class*="thread"]').first();
        // Fallback: look for the thread title text in the sidebar
        await expect(
            page.getByText('Thread persistence test message').first()
        ).toBeVisible({ timeout: 15000 });
    });

    test('thread history reloads after page refresh via sidebar', async ({ page }) => {
        await gotoAgentChat(page);
        await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 15000 });

        // Send a message
        const testMessage = `Refresh test ${Date.now()}`;
        await page.getByTestId('chat-input').fill(testMessage);
        await page.getByTestId('chat-send-button').click();

        // Wait for user message to appear
        await expect(page.getByTestId('user-message').first()).toBeVisible({ timeout: 10000 });

        // Wait for AI response so the thread is fully persisted
        await expect(page.getByTestId('ai-message').first()).toBeVisible({ timeout: 120000 });

        // Reload the page
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 15000 });

        // Open thread sidebar
        await openThreadSidebar(page);

        // The previous thread should appear in the sidebar
        await expect(
            page.getByText(testMessage).first()
        ).toBeVisible({ timeout: 15000 });

        // Click the thread to reload it
        await page.getByText(testMessage).first().click();

        // The original message should reload in the chat
        await expect(
            page.getByTestId('user-message').first()
        ).toBeVisible({ timeout: 15000 });
        await expect(
            page.getByTestId('user-message').first()
        ).toContainText(testMessage);
    });
});

// ─── Thread List ──────────────────────────────────────────────────────────────

test.describe('Agent Chat — Thread List', () => {
    test.beforeEach(async ({ page }) => {
        await gotoAgentChat(page);
        await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 15000 });
    });

    test('history button opens thread sidebar', async ({ page }) => {
        await openThreadSidebar(page);
        // Sidebar should show a search input or thread list area
        await expect(
            page.getByPlaceholder('Search threads...')
        ).toBeVisible({ timeout: 10000 });
    });

    test('new chat button creates a fresh conversation', async ({ page }) => {
        // Send a message to populate the current thread
        await page.getByTestId('chat-input').fill('First thread message');
        await page.getByTestId('chat-send-button').click();
        await expect(page.getByTestId('user-message').first()).toBeVisible({ timeout: 10000 });

        // Open sidebar and click New Chat
        await openThreadSidebar(page);
        await page.getByRole('button', { name: /New Chat/i }).first().click();

        // The chat should be empty (empty state shown)
        await expect(
            page.getByText('Start a Conversation')
        ).toBeVisible({ timeout: 10000 });
    });
});
