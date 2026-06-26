/**
 * Auth setup — generates a valid NextAuth session cookie so all tests
 * start already authenticated. Runs once before all test projects.
 */
import { test as setup, expect } from '@playwright/test';
import path from 'path';

export const STORAGE_STATE = path.resolve(__dirname, '.auth/session.json');

setup.setTimeout(90000);
setup('create authenticated session', async ({ page }) => {
    // Use next-auth/jwt encode to mint a valid session token
    // We do this via a small Node.js script piped through the shell so we
    // don't need to bundle next-auth into the test runner itself.
    const { execSync } = await import('child_process');

    const secret = 'web-ui-nextauth-secret-change-in-production-or-use-secrets';

    const tokenJson = execSync(
        `node -e "
const { encode } = require('${path.resolve(__dirname, '../../node_modules/next-auth/jwt')}');
encode({
    token: {
        name: 'Test User',
        email: 'kartikmanimuthu@smcindiaonline.com',
        sub: 'test-user-id',
        groups: ['SuperAdmins'],
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 86400,
    },
    secret: '${secret}',
}).then(t => process.stdout.write(t));
"`
    ).toString().trim();

    // Set the session cookie directly
    await page.context().addCookies([
        {
            name: 'next-auth.session-token',
            value: tokenJson,
            domain: 'localhost',
            path: '/',
            httpOnly: true,
            sameSite: 'Lax',
            expires: Math.floor(Date.now() / 1000) + 86400,
        },
    ]);

    // Verify we can reach the inventory page without redirect to login
    await page.goto('/app/inventory', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await expect(page).not.toHaveURL(/login/);

    // Save storage state for all tests
    await page.context().storageState({ path: STORAGE_STATE });
});
