/**
 * Visual-check harness for the UI visual refactor (Playwright CLI — NOT MCP).
 *
 * Captures full-page screenshots of routes against the running dev server
 * (http://localhost:3001) so loop sessions can compare the rendered UI to the
 * chatbot reference. /app/* routes reuse the e2e session cookie
 * (.auth/session.json); public routes (/login, /signup, /create-org, /) load
 * unauthenticated.
 *
 * Usage:
 *   cd apps/web-ui-e2e
 *   bunx tsx visual-check.ts /login /app/dashboard /app/audit
 *   SHOT_DIR=/abs/out bunx tsx visual-check.ts /app/accounts   # custom out dir
 *
 * Output: PNGs in $SHOT_DIR (default ./.shots, gitignored). NOT committed.
 */
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:3001';
const STORAGE = path.join(__dirname, '.auth/session.json');
const OUT = process.env.SHOT_DIR || path.join(__dirname, '.shots');

const routes = process.argv.slice(2);
if (routes.length === 0) {
  console.error('usage: bunx tsx visual-check.ts <route> [route...]');
  process.exit(1);
}

const needsAuth = (r: string) => r.startsWith('/app');

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const hasStorage = fs.existsSync(STORAGE);

  for (const route of routes) {
    const useAuth = needsAuth(route) && hasStorage;
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      storageState: useAuth ? STORAGE : undefined,
    });
    const page = await context.newPage();
    try {
      await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle', timeout: 30_000 });
      await page.waitForTimeout(600); // let transitions settle
      const file = path.join(OUT, `${route.replace(/\//g, '_') || '_root'}.png`);
      await page.screenshot({ path: file, fullPage: true });
      console.log(`✓ ${route} -> ${file}${useAuth ? ' (authed)' : ''}`);
    } catch (err) {
      console.error(`✗ ${route}: ${(err as Error).message}`);
    } finally {
      await context.close();
    }
  }
  await browser.close();
}

main();
