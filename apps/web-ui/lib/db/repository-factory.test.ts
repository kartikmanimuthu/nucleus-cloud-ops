import { describe, it, expect } from 'vitest';
import { isUsingPostgres } from './repository-factory';

// NOTE: the 25 getXxxRepository() factory functions each lazy-load their
// Postgres implementation via a same-directory `require('./repositories/.../postgres')`
// call. That require() is Node's native runtime require, not routed through
// Vite/Vitest's ESM module graph — so neither a real import nor a vi.mock() of
// the target module intercepts it here ("Cannot find module", even though the
// file exists and resolves fine under the real Next.js/Node runtime). This is a
// test-harness limitation, not a production defect: confirmed by every route
// test in this repo that mocks e.g. `@/lib/db/repository-factory` wholesale and
// exercises the returned repository via its interface instead. Only the one
// piece of real logic in this file that doesn't go through require() is tested
// directly.
describe('isUsingPostgres', () => {
    it('always returns true regardless of the flag name (all entities are on Postgres)', () => {
        expect(isUsingPostgres('anything')).toBe(true);
        expect(isUsingPostgres('')).toBe(true);
        expect(isUsingPostgres('legacy-flag')).toBe(true);
    });
});
