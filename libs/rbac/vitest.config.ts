import { defineConfig } from 'vitest/config';

// libs/rbac is framework-free by contract: no next/, no react/ imports anywhere
// under this directory. That is why this config has no react plugin and no jsdom
// environment — the compiler must be testable without Next.
export default defineConfig({
    test: {
        environment: 'node',
        globals: true,
        coverage: {
            provider: 'v8',
            reportOnFailure: true,
            reporter: ['text-summary', 'json-summary', 'html', 'lcov'],
            include: ['*.ts'],
            exclude: ['**/*.test.ts', 'vitest.config.ts', 'generated/**'],
        },
    },
});
