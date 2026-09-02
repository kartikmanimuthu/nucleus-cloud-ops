import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
    plugins: [react()],
    // Snapshot once, in the main process, before any test file's imports run.
    // The *.integration.test.ts DB-gated suites read this instead of live
    // process.env.DATABASE_URL: constructing a real PrismaClient (which one of
    // those suites necessarily does, even to fail with "connection refused")
    // triggers Prisma's own .env auto-load as a side effect, mutating
    // process.env for the rest of the worker — a later file in the same worker
    // would then see DATABASE_URL as truthy and incorrectly run instead of skip.
    define: {
        __HAS_DB__: JSON.stringify(Boolean(process.env.DATABASE_URL)),
    },
    test: {
        environment: 'node',
        globals: true,
        /**
         * Vitest's default is 5s, which several jsdom COMPONENT tests here sit
         * right on top of — a full RHF form with Radix primitives takes ~5s to
         * first paint under worker contention. The symptom was ugly: a stable
         * directory would fail 1-6 tests per run, in a DIFFERENT file each time,
         * always as a bare "Test timed out in 5000ms" with nothing to diagnose,
         * and every one of them passing in isolation.
         *
         * role-dialog.test.tsx already worked around it with a hand-rolled
         * `}, 30000)`. This makes that the default instead of a thing each new
         * component test has to rediscover. It weakens no assertion — a genuinely
         * hung test still fails, just 20s later.
         */
        testTimeout: 20_000,
        environmentMatchGlobs: [
            ['**/__tests__/**/*.test.tsx', 'jsdom'],
        ],
        coverage: {
            provider: 'v8',
            // Suite has failures until Phase 0c lands; without this a red run
            // prints no report at all (silent 0-line coverage, not an error).
            reportOnFailure: true,
            reporter: ['text-summary', 'json-summary', 'html', 'lcov'],
            include: [
                'app/**/*.{ts,tsx}',
                'components/**/*.{ts,tsx}',
                'lib/**/*.{ts,tsx}',
                'hooks/**/*.{ts,tsx}',
                'providers/**/*.{ts,tsx}',
                'middleware.ts',
            ],
            exclude: [
                '**/*.test.*',
                '**/__tests__/**',
                '**/tests/**',
                '**/*.d.ts',
                '**/__fixtures__/**',
            ],
        },
    },
    resolve: {
        alias: {
            '@': path.resolve(__dirname, '.'),
        },
    },
});
