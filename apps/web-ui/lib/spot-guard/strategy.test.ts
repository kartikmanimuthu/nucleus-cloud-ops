// web-ui/lib/spot-guard/strategy.test.ts
//
// Drives the SHARED fixture (__fixtures__/strategy-vectors.json) against the web-ui copy of
// the strategy logic. apps/workers/src/jobs/spot-guard/services/engine.vectors.test.ts
// drives the SAME fixture against the workers copy, so a change to either implementation
// that is not reflected in the fixture fails on both sides.
import { describe, it, expect } from 'vitest';
import vectors from './__fixtures__/strategy-vectors.json';
import {
    FALLBACK_ON_DEMAND_WEIGHT,
    RESTORE_SPOT_MIN_WEIGHT,
    addSpotProvider,
    buildFallbackStrategy,
    buildSpotFirstStrategy,
    deriveCapacityState,
    hasSpotProvider,
    isFallbackState,
    isSpotFirstState,
    isSpotProvider,
    strategyEquals,
} from './strategy';
import type { CapacityProviderStrategyItem } from '@/lib/db/repositories/spot-guard/interface';

describe('shared strategy vectors (web-ui copy)', () => {
    it('agrees with the fixture on the tunable constants', () => {
        expect(FALLBACK_ON_DEMAND_WEIGHT).toBe(vectors.fallbackOnDemandWeight);
        expect(RESTORE_SPOT_MIN_WEIGHT).toBe(vectors.restoreSpotMinWeight);
    });

    for (const c of vectors.cases) {
        describe(c.name, () => {
            const input = c.input as CapacityProviderStrategyItem[];

            it('buildFallbackStrategy matches', () => {
                expect(strategyEquals(buildFallbackStrategy(input), c.fallback as CapacityProviderStrategyItem[])).toBe(
                    true,
                );
            });

            it('buildSpotFirstStrategy matches', () => {
                expect(strategyEquals(buildSpotFirstStrategy(input), c.spotFirst as CapacityProviderStrategyItem[])).toBe(
                    true,
                );
            });

            it('isFallbackState matches', () => {
                expect(isFallbackState(input)).toBe(c.isFallbackState);
            });

            it('isSpotFirstState matches', () => {
                expect(isSpotFirstState(input)).toBe(c.isSpotFirstState);
            });

            it('deriveCapacityState matches', () => {
                expect(deriveCapacityState(input)).toBe(c.capacityState);
            });
        });
    }
});

describe('web-ui-only behaviour', () => {
    it('isSpotProvider matches spot substrings case-insensitively', () => {
        expect(isSpotProvider('FARGATE_SPOT')).toBe(true);
        expect(isSpotProvider('my-spot-asg')).toBe(true);
        expect(isSpotProvider('FARGATE')).toBe(false);
    });

    it('honours an explicit spotWeight on enable', () => {
        const out = buildSpotFirstStrategy(
            [
                { capacityProvider: 'FARGATE', weight: 10, base: 0 },
                { capacityProvider: 'FARGATE_SPOT', weight: 0, base: 0 },
            ],
            { spotWeight: 100 },
        );
        expect(out.find((c) => c.capacityProvider === 'FARGATE_SPOT')?.weight).toBe(100);
    });

    /**
     * An explicit spotWeight must SET the weight, not floor it.
     *
     * Every existing case here only ever raised it (0 -> 100), so Math.max(existing, requested)
     * looked correct and shipped. Lowering was silently ignored: stx-kyc-ekyc-admin-api sat at
     * FARGATE_SPOT w100, an operator asked for 50%, and max(100, 50) kept Spot at 100 — the service
     * landed on w100/w50, which is 67% Spot, and the console honestly displayed 67%.
     */
    describe('lowering the Spot share', () => {
        const at = (spot: number, onDemand: number) => [
            { capacityProvider: 'FARGATE_SPOT', weight: spot, base: 0 },
            { capacityProvider: 'FARGATE', weight: onDemand, base: 0 },
        ];
        const weights = (out: { capacityProvider: string; weight?: number }[]) => ({
            spot: out.find((c) => c.capacityProvider === 'FARGATE_SPOT')?.weight,
            onDemand: out.find((c) => c.capacityProvider === 'FARGATE')?.weight,
        });

        it('drops Spot from 100 to 50 when 50/50 is requested', () => {
            const out = buildSpotFirstStrategy(at(100, 0), { spotWeight: 50, onDemandWeight: 50 });
            expect(weights(out)).toEqual({ spot: 50, onDemand: 50 });
        });

        it('produces the exact ratio the operator picked, not a floored one', () => {
            // 30% must be 30/70 — 30/(30+70) — regardless of where the service started.
            const out = buildSpotFirstStrategy(at(100, 0), { spotWeight: 30, onDemandWeight: 70 });
            const { spot, onDemand } = weights(out);
            expect(Math.round((spot! / (spot! + onDemand!)) * 100)).toBe(30);
        });

        it('still RAISES when the request is higher, as before', () => {
            const out = buildSpotFirstStrategy(at(1, 0), { spotWeight: 100, onDemandWeight: 0 });
            expect(weights(out)).toEqual({ spot: 100, onDemand: 0 });
        });

        it('keeps flooring when no explicit weight is given — the restore path is unchanged', () => {
            // Restore passes no spotWeight and relies on the minimum-weight floor, so a baseline
            // already above the floor must not be reduced to it.
            const out = buildSpotFirstStrategy(at(100, 0), {});
            expect(weights(out).spot).toBe(100);
        });
    });

    it('honours an explicit onDemandBase, so a user can keep guaranteed capacity', () => {
        const out = buildSpotFirstStrategy(
            [
                { capacityProvider: 'FARGATE', weight: 10, base: 0 },
                { capacityProvider: 'FARGATE_SPOT', weight: 0, base: 0 },
            ],
            { spotWeight: 100, onDemandBase: 2 },
        );
        expect(out.find((c) => c.capacityProvider === 'FARGATE')).toEqual({
            capacityProvider: 'FARGATE',
            weight: 0,
            base: 2,
        });
    });

    it('clamps spotWeight to at least 1, so enable can never be a no-op', () => {
        // A weight-0 Spot provider places nothing; accepting 0 here would silently produce
        // an "enabled" service still running entirely On-Demand.
        const out = buildSpotFirstStrategy([{ capacityProvider: 'FARGATE_SPOT', weight: 0 }], { spotWeight: 0 });
        expect(out[0].weight).toBe(1);
        expect(isSpotFirstState(out)).toBe(true);
    });

    describe('addSpotProvider', () => {
        it('adds a Spot provider to a strategy that has none', () => {
            const out = addSpotProvider([{ capacityProvider: 'FARGATE', weight: 1, base: 0 }], 'FARGATE_SPOT', {
                spotWeight: 100,
            });
            expect(hasSpotProvider(out)).toBe(true);
            expect(isSpotFirstState(out)).toBe(true);
            expect(out.find((c) => c.capacityProvider === 'FARGATE')?.weight).toBe(0);
        });

        it('does not duplicate an existing Spot provider', () => {
            const out = addSpotProvider(
                [
                    { capacityProvider: 'FARGATE', weight: 10 },
                    { capacityProvider: 'FARGATE_SPOT', weight: 0 },
                ],
                'FARGATE_SPOT',
            );
            expect(out.filter((c) => c.capacityProvider === 'FARGATE_SPOT')).toHaveLength(1);
            expect(isSpotFirstState(out)).toBe(true);
        });

        it('preserves the provider set otherwise', () => {
            const out = addSpotProvider([{ capacityProvider: 'FARGATE', weight: 1 }], 'FARGATE_SPOT');
            expect(out.map((c) => c.capacityProvider).sort()).toEqual(['FARGATE', 'FARGATE_SPOT']);
        });
    });

    it('strategyEquals ignores order and treats missing weight/base as 0', () => {
        expect(
            strategyEquals(
                [{ capacityProvider: 'A' }, { capacityProvider: 'B', weight: 1 }],
                [{ capacityProvider: 'B', weight: 1, base: 0 }, { capacityProvider: 'A', weight: 0, base: 0 }],
            ),
        ).toBe(true);
    });
});
