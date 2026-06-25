import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

// Playwright config lives inside the e2e Nx project (apps/web-ui-e2e/).
// Specs and auth.setup.ts sit directly in this directory; .auth/session.json is the
// minted storage state written by the setup project.

const STORAGE_STATE = path.join(__dirname, '.auth/session.json');

export default defineConfig({
  testDir: '.',
  fullyParallel: false, // inventory tests share state; run sequentially
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [['html'], ['list']],
  use: {
    baseURL: 'http://localhost:3001',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    // Setup: mint a session cookie before any test runs
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        storageState: STORAGE_STATE,
      },
      dependencies: ['setup'],
      testIgnore: /auth\.setup\.ts/,
    },
  ],

  webServer: {
    // Escape the project dir to the repo root and run the root `dev` script
    // (sh ./scripts/nx-run.sh serve web-ui -> next dev -p 3001).
    command: 'export AWS_PROFILE=PLATFORM-ADMIN && cd ../.. && bun run dev',
    url: 'http://localhost:3001',
    reuseExistingServer: true, // reuse the already-running dev server
    timeout: 120_000,
  },
});