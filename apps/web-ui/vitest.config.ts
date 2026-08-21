import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
    plugins: [react()],
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
    },
    resolve: {
        alias: {
            '@': path.resolve(__dirname, '.'),
        },
    },
});
