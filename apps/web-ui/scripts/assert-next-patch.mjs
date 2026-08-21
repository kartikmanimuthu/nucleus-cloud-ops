#!/usr/bin/env node
/**
 * Build-time guard for patches/next@15.5.15.patch.
 *
 * middleware.ts runs on the Node.js runtime because Layer 1 needs Prisma. That
 * makes Next clone the request body for the middleware and then swap the drained
 * original for the buffered copy — through an UNAWAITED `finalize()` in
 * next-server.js `runMiddleware`. Next's own edge path awaits the same call. Lose
 * the race and the route handler builds its Request from the already-disturbed
 * stream, so Next throws "Response body object should not be disturbed or locked"
 * before a line of our code runs. Large POSTs (chat with a grown thread, ask-ai,
 * the gateways, KB uploads) lose it reliably.
 *
 * bun keys patches by exact version, so `next@15.5.16` would stop matching
 * `next@15.5.15` and the fix would vanish with no error — the 500s would come back
 * in production. This script exists so that failure is a red build instead.
 *
 * On a Next upgrade, open node_modules/next/dist/server/next-server.js and look at
 * `requestData.body.finalize()` in runMiddleware:
 *   · upstream now awaits it  -> delete the patch, this script, and its two hooks
 *     (prebuild in apps/web-ui/package.json, the build target in project.json)
 *   · upstream still does not -> regenerate the patch for the new version and
 *     update PATCHED_VERSION below
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const PATCHED_VERSION = '15.5.15';
const MARKER = 'await requestData.body.finalize';
const ESCAPE_HATCH = 'SKIP_NEXT_PATCH_ASSERT';

function fail(lines) {
    console.error('\n  next patch assertion FAILED\n');
    for (const line of lines) console.error(`  ${line}`);
    console.error(`\n  Override for a one-off local build: ${ESCAPE_HATCH}=1\n`);
    process.exit(1);
}

if (process.env[ESCAPE_HATCH] === '1') {
    console.warn(`[assert-next-patch] skipped via ${ESCAPE_HATCH}=1`);
    process.exit(0);
}

const require = createRequire(import.meta.url);

let nextPkgPath;
try {
    nextPkgPath = require.resolve('next/package.json', { paths: [process.cwd()] });
} catch {
    fail([
        'Could not resolve the `next` package from ' + process.cwd() + '.',
        'Dependencies are probably not installed — run `bun install` first.',
    ]);
}

const nextRoot = path.dirname(nextPkgPath);
const installed = JSON.parse(readFileSync(nextPkgPath, 'utf8')).version;
const target = path.join(nextRoot, 'dist', 'server', 'next-server.js');

let source;
try {
    source = readFileSync(target, 'utf8');
} catch {
    fail([`Could not read ${target}.`, 'The next package layout changed — this guard needs updating.']);
}

if (source.includes(MARKER)) {
    console.log(`[assert-next-patch] OK — next@${installed} has the awaited finalize()`);
    process.exit(0);
}

// Not patched. Distinguish "version moved on" from "install did not apply it",
// because the fix is different in each case.
if (installed !== PATCHED_VERSION) {
    fail([
        `next is ${installed}, but patches/next@${PATCHED_VERSION}.patch only applies to ${PATCHED_VERSION}.`,
        'bun silently skips a patch whose version key no longer matches, so the',
        'body-locking fix is NOT in this build and large POSTs through middleware',
        'will 500 (vercel/next.js#83453 territory).',
        '',
        `Check runMiddleware in ${path.relative(process.cwd(), target)}:`,
        '  · if upstream now awaits requestData.body.finalize(), drop the patch and this guard',
        '  · otherwise regenerate the patch for ' + installed + ' and bump PATCHED_VERSION',
    ]);
}

fail([
    `next is ${installed} — the expected version — but the patch is not applied.`,
    'The install did not pick it up. Check that:',
    '  · patches/next@15.5.15.patch exists and was copied into the build context',
    '  · patchedDependencies lists it in BOTH package.json and bun.lock',
    '    (root and apps/web-ui — the Docker build installs from apps/web-ui)',
    'Then re-run `bun install`.',
]);
