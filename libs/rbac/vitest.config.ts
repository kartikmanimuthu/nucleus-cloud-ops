import { defineConfig } from 'vitest/config';

// libs/rbac is framework-free by contract: no next/, no react/ imports anywhere
// under this directory. That is why this config has no react plugin and no jsdom
// environment — the compiler must be testable without Next.
export default defineConfig({
    test: {
        environment: 'node',
        globals: true,
        // The suites land with the compiler in Workstream C; until then this
        // project exists so `nx run-many -t test --all` already includes it.
        passWithNoTests: true,
    },
});
