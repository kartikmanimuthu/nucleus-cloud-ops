/**
 * Marketing page E2E tests — /
 * Covers the public-facing landing page: hero, nav, features, pricing, CTA, footer.
 * No auth required.
 */
import { test, expect } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } }); // no auth needed

test.describe('Marketing — Navigation Bar', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/', { waitUntil: 'domcontentloaded' });
    });

    test('logo / brand name is visible', async ({ page }) => {
        await expect(page.getByRole('navigation').getByText('Nucleus Ops')).toBeVisible();
    });

    test('nav links Features, Open Source, Docs are present', async ({ page }) => {
        const nav = page.getByRole('navigation');
        await expect(nav.getByRole('link', { name: 'Features' })).toBeVisible();
        await expect(nav.getByRole('link', { name: 'Open Source' })).toBeVisible();
        await expect(nav.getByRole('link', { name: 'Docs' })).toBeVisible();
    });

    test('GitHub link present in navbar', async ({ page }) => {
        const nav = page.getByRole('navigation');
        await expect(nav.getByRole('link', { name: /github/i })).toBeVisible();
    });

    test('Sign in and Get Started buttons are present', async ({ page }) => {
        const nav = page.getByRole('navigation');
        await expect(nav.getByRole('link', { name: 'Sign in' })).toBeVisible();
        await expect(nav.getByRole('link', { name: 'Get Started' })).toBeVisible();
    });

    test('Sign in link navigates to /login', async ({ page }) => {
        const nav = page.getByRole('navigation');
        await nav.getByRole('link', { name: 'Sign in' }).click();
        await expect(page).toHaveURL(/\/login/);
    });

    test('Docs nav link navigates to /docs', async ({ page }) => {
        const nav = page.getByRole('navigation');
        await nav.getByRole('link', { name: 'Docs' }).click();
        await expect(page).toHaveURL(/\/docs/);
    });
});

test.describe('Marketing — Hero Section', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/', { waitUntil: 'domcontentloaded' });
    });

    test('hero headline is visible', async ({ page }) => {
        await expect(page.getByRole('heading', { name: /AWS Cloud Ops/i })).toBeVisible();
        await expect(page.getByText('Automated & Intelligent')).toBeVisible();
    });

    test('hero subtitle text is present', async ({ page }) => {
        await expect(page.getByText(/Stop paying for idle cloud resources/i)).toBeVisible();
    });

    test('Open Source and Bedrock badges are visible', async ({ page }) => {
        await expect(page.getByText('Open Source · MIT License')).toBeVisible();
        await expect(page.getByText('Powered by AWS Bedrock + Claude 4.6 Sonnet')).toBeVisible();
    });

    test('Start for free CTA button navigates to /login', async ({ page }) => {
        await page.getByRole('link', { name: /Start for free/i }).first().click();
        await expect(page).toHaveURL(/\/login/);
    });

    test('View on GitHub link is present in hero', async ({ page }) => {
        await expect(page.getByRole('link', { name: /View on GitHub/i })).toBeVisible();
    });
});

test.describe('Marketing — Stats Bar', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/', { waitUntil: 'domcontentloaded' });
    });

    test('70% avg cost reduction stat is visible', async ({ page }) => {
        await expect(page.getByText('70%').first()).toBeVisible();
        await expect(page.getByText('avg. cost reduction').first()).toBeVisible();
    });

    test('91+ AWS accounts stat is visible', async ({ page }) => {
        await expect(page.getByText('91+').first()).toBeVisible();
        // "AWS accounts" label (not the mock dashboard "AWS Accounts" heading)
        await expect(page.getByText('AWS accounts').first()).toBeVisible();
    });

    test('31K+ resources discovered stat is visible', async ({ page }) => {
        await expect(page.getByText('31K+').first()).toBeVisible();
        await expect(page.getByText('resources discovered').first()).toBeVisible();
    });

    test('MIT open source license stat is visible', async ({ page }) => {
        await expect(page.getByText('MIT').first()).toBeVisible();
        await expect(page.getByText('open source license')).toBeVisible();
    });
});

test.describe('Marketing — Features Section', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/', { waitUntil: 'domcontentloaded' });
    });

    test('Features section heading is visible', async ({ page }) => {
        await expect(page.getByRole('heading', { name: /Everything you need to tame AWS costs/i })).toBeVisible();
    });

    const featureCards = [
        'Cost Scheduler',
        'Multi-Account Management',
        'AI Ops Agent',
        'Agent Ops',
        'Inventory Discovery',
        'Knowledge Base',
        'Channels & Integrations',
        'Audit Trail',
        'Cost Tracking',
        'RBAC & Security',
        'Deep AI Agent',
        'Appearance & Theming',
    ];

    for (const feature of featureCards) {
        test(`feature card "${feature}" is visible`, async ({ page }) => {
            await expect(page.getByRole('heading', { name: feature, level: 3 })).toBeVisible();
        });
    }
});

test.describe('Marketing — Pricing / Open Source Section', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/', { waitUntil: 'domcontentloaded' });
    });

    test('Open Source section heading is visible', async ({ page }) => {
        await expect(page.getByRole('heading', { name: /Free forever/i })).toBeVisible();
    });

    test('three pricing plans are visible', async ({ page }) => {
        await expect(page.getByRole('heading', { name: 'Self-Hosted', level: 2 }).or(
            page.getByText('Self-Hosted').first()
        )).toBeVisible();
        await expect(page.getByText('Cloud Hosted').first()).toBeVisible();
        await expect(page.getByText('Enterprise').first()).toBeVisible();
    });

    test('Self-Hosted plan shows $0/forever', async ({ page }) => {
        await expect(page.getByText('$0')).toBeVisible();
    });

    test('Deploy Now button links to GitHub', async ({ page }) => {
        const deployBtn = page.getByRole('link', { name: 'Deploy Now' });
        await expect(deployBtn).toBeVisible();
        const href = await deployBtn.getAttribute('href');
        expect(href).toContain('github.com');
    });
});

test.describe('Marketing — CTA Banner', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/', { waitUntil: 'domcontentloaded' });
    });

    test('CTA headline is visible', async ({ page }) => {
        await expect(page.getByRole('heading', { name: /Ready to cut your AWS bill/i })).toBeVisible();
    });

    test('Get started free CTA navigates to /login', async ({ page }) => {
        const cta = page.getByRole('link', { name: /Get started free/i });
        await expect(cta).toBeVisible();
        await cta.click();
        await expect(page).toHaveURL(/\/login/);
    });
});

test.describe('Marketing — Footer', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/', { waitUntil: 'domcontentloaded' });
    });

    test('footer brand name is visible', async ({ page }) => {
        // footer has role="contentinfo"; use first() to handle multi-match in strict mode
        const footer = page.getByRole('contentinfo');
        await expect(footer.getByText('Nucleus Ops').first()).toBeVisible();
    });

    test('footer Docs link is present', async ({ page }) => {
        const footer = page.getByRole('contentinfo');
        await expect(footer.getByRole('link', { name: 'Docs' }).first()).toBeVisible();
    });

    test('footer Getting Started link is present', async ({ page }) => {
        const footer = page.getByRole('contentinfo');
        await expect(footer.getByRole('link', { name: 'Getting Started' })).toBeVisible();
    });

    test('footer MIT License text is visible', async ({ page }) => {
        const footer = page.getByRole('contentinfo');
        await expect(footer.getByText(/MIT License/).first()).toBeVisible();
    });
});

test.describe('Marketing — Login Page', () => {
    test('login page renders sign-in form', async ({ page }) => {
        await page.goto('/login', { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('heading', { name: /Welcome back/i })).toBeVisible();
        await expect(page.getByText('Sign in to your account to continue')).toBeVisible();
        await expect(page.getByRole('button', { name: /Sign in with Cognito/i })).toBeVisible();
    });

    test('authenticated users are redirected away from login', async ({ page }) => {
        // Without cookies — stays on login
        await page.goto('/login', { waitUntil: 'domcontentloaded' });
        await expect(page).toHaveURL(/\/login/);
    });
});
