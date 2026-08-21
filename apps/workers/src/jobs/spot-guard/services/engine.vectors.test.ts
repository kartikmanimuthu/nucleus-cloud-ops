// workers/src/jobs/spot-guard/services/engine.vectors.test.ts
//
// Drives the SHARED fixture against the WORKERS copy of the strategy logic.
//
// The same fixture is driven against the web-ui copy by
// apps/web-ui/lib/spot-guard/strategy.test.ts. web-ui cannot import from apps/workers
// (separate npm packages), so the logic necessarily exists twice; drift between the copies
// would let the UI enable Spot with one strategy shape while this engine asserts a
// different one, producing an endless hourly update loop.
//
// The fixture is imported ACROSS the app boundary by relative path on purpose — it is test
// data, not runtime code, so it creates no build coupling, and pointing both suites at one
// file is what makes the guard real. A copied fixture would guard nothing.
import { describe, it, expect } from 'vitest';
import vectors from '../../../../../web-ui/lib/spot-guard/__fixtures__/strategy-vectors.json';
import { SPOT_GUARD_CONFIG } from '../config.js';
import type { CapacityProviderStrategyItem } from '../types.js';
import {
    buildFallbackStrategy,
    buildSpotFirstStrategy,
    deriveCapacityState,
    isFallbackState,
    isSpotFirstState,
    strategyEquals,
} from './engine.js';

describe('shared strategy vectors (workers copy)', () => {
    it('agrees with the fixture on the tunable constants', () => {
        // If these diverge, every downstream vector comparison is meaningless.
        expect(SPOT_GUARD_CONFIG.fallbackOnDemandWeight).toBe(vectors.fallbackOnDemandWeight);
        expect(SPOT_GUARD_CONFIG.restoreSpotMinWeight).toBe(vectors.restoreSpotMinWeight);
    });

    for (const c of vectors.cases) {
        describe(c.name, () => {
            const input = c.input as CapacityProviderStrategyItem[];

            it('buildFallbackStrategy matches the shared vector', () => {
                const actual = buildFallbackStrategy(input, SPOT_GUARD_CONFIG);
                expect(strategyEquals(actual, c.fallback as CapacityProviderStrategyItem[])).toBe(true);
            });

            it('buildSpotFirstStrategy matches the shared vector', () => {
                const actual = buildSpotFirstStrategy(input, SPOT_GUARD_CONFIG);
                expect(strategyEquals(actual, c.spotFirst as CapacityProviderStrategyItem[])).toBe(true);
            });

            it('isFallbackState matches the shared vector', () => {
                expect(isFallbackState(input)).toBe(c.isFallbackState);
            });

            it('isSpotFirstState matches the shared vector', () => {
                expect(isSpotFirstState(input)).toBe(c.isSpotFirstState);
            });

            it('deriveCapacityState matches the shared vector', () => {
                expect(deriveCapacityState(input)).toBe(c.capacityState);
            });
        });
    }
});
