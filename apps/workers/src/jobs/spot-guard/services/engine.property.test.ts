// workers/src/jobs/spot-guard/services/engine.property.test.ts
//
// Property-based tests (fast-check) for the Spot Guard decision core.
//
// These exist because the failure modes that actually hurt here are not "wrong output
// for one input" — they are invariant violations under repetition and duplicate
// delivery. The pipeline is at-least-once (SQS → pg-boss, both replicas polling), so
// idempotence and round-trip stability are correctness requirements, not niceties.
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { SPOT_GUARD_CONFIG } from '../config.js';
import type { CapacityProviderStrategyItem } from '../types.js';
import {
    buildFallbackStrategy,
    buildSpotFirstStrategy,
    computeBackoffUntil,
    evaluatePlacementFailure,
    evaluateRestore,
    hasSpotProvider,
    isFallbackState,
    isSpotFirstState,
    isSpotProvider,
    strategyEquals,
} from './engine.js';

const cfg = SPOT_GUARD_CONFIG;

/** Provider names deliberately mixing real ECS names, custom Spot providers, and
 *  adversarial near-misses so the substring matcher is exercised both ways. */
const providerName = fc.oneof(
    fc.constant('FARGATE'),
    fc.constant('FARGATE_SPOT'),
    fc.constant('my-spot-asg'),
    fc.constant('SPOTLIGHT'),
    fc.constant('EC2'),
    fc.constant('on-demand-cp'),
    fc.string({ minLength: 1, maxLength: 12 }),
);

const strategyItem = fc.record({
    capacityProvider: providerName,
    weight: fc.integer({ min: 0, max: 1000 }),
    base: fc.integer({ min: 0, max: 100 }),
});

/** Unique provider names — ECS rejects a strategy with duplicates. */
const strategy = fc
    .array(strategyItem, { minLength: 1, maxLength: 6 })
    .map((items) => {
        const seen = new Set<string>();
        return items.filter((i) => {
            if (seen.has(i.capacityProvider)) return false;
            seen.add(i.capacityProvider);
            return true;
        });
    })
    .filter((items) => items.length > 0);

const providerSet = (s: CapacityProviderStrategyItem[]) => new Set(s.map((c) => c.capacityProvider));

// ── Targeted arbitraries ──────────────────────────────────────────────────────
//
// The unconstrained `strategy` arbitrary above almost never lands in a fallback
// state (it needs Spot present AND every Spot weight exactly 0) or satisfies all
// seven restore gates at once. Using fc.pre() to filter for those starves the run
// ("too many pre-condition failures") and silently tests nothing. These construct the
// interesting states directly, so the properties below assert an outcome rather than
// filtering for one.

const spotProviderName = fc.constantFrom('FARGATE_SPOT', 'my-spot-asg', 'SPOTLIGHT');
const onDemandProviderName = fc.constantFrom('FARGATE', 'EC2', 'on-demand-cp');

/** A strategy that is definitionally in fallback: Spot present, all Spot weights 0. */
const fallbackStrategyArb = fc
    .tuple(
        fc.uniqueArray(spotProviderName, { minLength: 1, maxLength: 3 }),
        fc.uniqueArray(onDemandProviderName, { minLength: 0, maxLength: 3 }),
        fc.integer({ min: 0, max: 100 }),
    )
    .map(([spots, onDemands, base]): CapacityProviderStrategyItem[] => [
        ...spots.map((n) => ({ capacityProvider: n, weight: 0, base: 0 })),
        ...onDemands.map((n) => ({ capacityProvider: n, weight: cfg.fallbackOnDemandWeight, base })),
    ]);

/** A strategy with at least one Spot provider actually eligible to place tasks. */
const spotFirstStrategyArb = fc
    .tuple(
        fc.uniqueArray(spotProviderName, { minLength: 1, maxLength: 3 }),
        fc.uniqueArray(onDemandProviderName, { minLength: 0, maxLength: 3 }),
        fc.integer({ min: 1, max: 1000 }),
        fc.integer({ min: 0, max: 100 }),
    )
    .map(([spots, onDemands, weight, base]): CapacityProviderStrategyItem[] => [
        ...spots.map((n) => ({ capacityProvider: n, weight, base: 0 })),
        ...onDemands.map((n) => ({ capacityProvider: n, weight: 0, base })),
    ]);

/**
 * An input that satisfies every restore gate, so evaluateRestore MUST return
 * 'restore'. backoffUntilMs stays strictly below nowMs; the live service is in
 * fallback so the self-heal branch fires regardless of restorePending.
 */
const restorableInputArb = fc.record({
    managementState: fc.constant('managed' as const),
    desiredStrategy: spotFirstStrategyArb,
    restorePending: fc.boolean(),
    backoffUntilMs: fc.oneof(fc.constant(null), fc.integer({ min: 0, max: 999_999 })),
    restoresInLast24h: fc.integer({ min: 0, max: cfg.maxRestoresPerServicePerDay - 1 }),
    nowMs: fc.constant(1_000_000),
    force: fc.boolean(),
    live: fc.record({
        currentStrategy: fallbackStrategyArb,
        desiredCount: fc.integer({ min: 1, max: 20 }),
        status: fc.constant('ACTIVE'),
        hasLoadBalancers: fc.boolean(),
        deploymentInProgress: fc.constant(false),
    }),
});

describe('buildFallbackStrategy properties', () => {
    it('preserves the provider set exactly — never drops or invents a provider', () => {
        // ECS rejects an UpdateService naming a provider the cluster does not have,
        // and dropping one silently changes the service's capacity options.
        fc.assert(
            fc.property(strategy, (s) => {
                expect(providerSet(buildFallbackStrategy(s, cfg))).toEqual(providerSet(s));
            }),
        );
    });

    it('zeroes every Spot weight and sets every non-Spot weight to the fallback weight', () => {
        fc.assert(
            fc.property(strategy, (s) => {
                for (const cp of buildFallbackStrategy(s, cfg)) {
                    expect(cp.weight).toBe(isSpotProvider(cp.capacityProvider) ? 0 : cfg.fallbackOnDemandWeight);
                }
            }),
        );
    });

    it('produces a DETECTABLE fallback state whenever Spot was present', () => {
        // If fallback state is not detectable, the hourly restore never fires and the
        // service stays on expensive On-Demand forever. This is the single most
        // important invariant in the feature.
        fc.assert(
            fc.property(strategy, (s) => {
                fc.pre(hasSpotProvider(s));
                expect(isFallbackState(buildFallbackStrategy(s, cfg))).toBe(true);
            }),
        );
    });

    it('is idempotent — duplicate delivery cannot drift the strategy', () => {
        fc.assert(
            fc.property(strategy, (s) => {
                const once = buildFallbackStrategy(s, cfg);
                expect(strategyEquals(buildFallbackStrategy(once, cfg), once)).toBe(true);
            }),
        );
    });

    it('preserves every On-Demand base guarantee (the bug the reference had)', () => {
        fc.assert(
            fc.property(strategy, (s) => {
                const out = buildFallbackStrategy(s, cfg);
                for (const cp of s) {
                    if (isSpotProvider(cp.capacityProvider)) continue;
                    expect(out.find((o) => o.capacityProvider === cp.capacityProvider)?.base).toBe(cp.base ?? 0);
                }
            }),
        );
    });
});

describe('buildSpotFirstStrategy properties', () => {
    it('preserves the provider set exactly', () => {
        fc.assert(
            fc.property(strategy, (s) => {
                expect(providerSet(buildSpotFirstStrategy(s, cfg))).toEqual(providerSet(s));
            }),
        );
    });

    it('always yields an actually-restorable strategy when Spot is present', () => {
        // Guarantees the reverter's own has_active_spot pre-flight abort can never
        // trigger on our own output — which in the reference was a silent dead end.
        fc.assert(
            fc.property(strategy, (s) => {
                fc.pre(hasSpotProvider(s));
                expect(isSpotFirstState(buildSpotFirstStrategy(s, cfg))).toBe(true);
            }),
        );
    });

    it('is idempotent', () => {
        fc.assert(
            fc.property(strategy, (s) => {
                const once = buildSpotFirstStrategy(s, cfg);
                expect(strategyEquals(buildSpotFirstStrategy(once, cfg), once)).toBe(true);
            }),
        );
    });

    it('round-trips: fallback(spotFirst(s)) === fallback(s)', () => {
        // Stability across arbitrarily many fallback→restore→fallback cycles. Without
        // this, weights could ratchet over months of interruptions.
        fc.assert(
            fc.property(strategy, (s) => {
                expect(
                    strategyEquals(
                        buildFallbackStrategy(buildSpotFirstStrategy(s, cfg), cfg),
                        buildFallbackStrategy(s, cfg),
                    ),
                ).toBe(true);
            }),
        );
    });

    it('keeps all weights and bases within the ECS API bounds', () => {
        fc.assert(
            fc.property(strategy, (s) => {
                for (const cp of [...buildSpotFirstStrategy(s, cfg), ...buildFallbackStrategy(s, cfg)]) {
                    expect(cp.weight).toBeGreaterThanOrEqual(0);
                    expect(cp.weight).toBeLessThanOrEqual(1000);
                    expect(cp.base).toBeGreaterThanOrEqual(0);
                    expect(cp.base).toBeLessThanOrEqual(100_000);
                }
            }),
        );
    });
});

describe('evaluatePlacementFailure properties', () => {
    it('never re-applies fallback to a service already in fallback', () => {
        fc.assert(
            fc.property(fallbackStrategyArb, (s) => {
                expect(isFallbackState(s)).toBe(true); // the arbitrary's own contract
                expect(evaluatePlacementFailure({ currentStrategy: s, serviceStatus: 'ACTIVE' }, cfg)).toMatchObject({
                    action: 'skip',
                    reason: 'already_on_demand',
                });
            }),
        );
    });

    it('NEVER persists a fallback strategy as the restore baseline', () => {
        // The one unrecoverable bug: a Spot-weight-0 strategy saved as desiredStrategy
        // makes the hourly job "restore" to On-Demand forever, and the customer
        // silently never returns to Spot pricing.
        fc.assert(
            fc.property(fallbackStrategyArb, (s) => {
                expect(
                    evaluatePlacementFailure({ currentStrategy: s, serviceStatus: 'ACTIVE' }, cfg)
                        .persistDesiredStrategy,
                ).toBe(false);
            }),
        );
    });

    it('any strategy it chooses to persist is genuinely restorable', () => {
        fc.assert(
            fc.property(strategy, (s) => {
                const d = evaluatePlacementFailure({ currentStrategy: s, serviceStatus: 'ACTIVE' }, cfg);
                fc.pre(d.action === 'apply_fallback');
                if (d.action !== 'apply_fallback') return;
                expect(isSpotFirstState(buildSpotFirstStrategy(d.desiredStrategy, cfg))).toBe(true);
            }),
        );
    });

    it('arms the backoff on BOTH the apply and already-in-fallback paths', () => {
        // Expressed as a property because this is the restore-thrashing fix.
        fc.assert(
            fc.property(strategy, (s) => {
                const d = evaluatePlacementFailure({ currentStrategy: s, serviceStatus: 'ACTIVE' }, cfg);
                if (d.action === 'apply_fallback' || (d.action === 'skip' && d.reason === 'already_on_demand')) {
                    expect(d.stampBackoff).toBe(true);
                }
            }),
        );
    });
});

describe('evaluateRestore properties', () => {
    const liveArb = fc.record({
        currentStrategy: strategy,
        desiredCount: fc.integer({ min: 0, max: 20 }),
        status: fc.constantFrom('ACTIVE', 'DRAINING', 'INACTIVE'),
        hasLoadBalancers: fc.boolean(),
        deploymentInProgress: fc.boolean(),
    });

    const inputArb = fc.record({
        managementState: fc.constantFrom('managed' as const, 'unmanaged' as const, 'opted_out' as const),
        desiredStrategy: strategy,
        restorePending: fc.boolean(),
        backoffUntilMs: fc.oneof(fc.constant(null), fc.integer({ min: 0, max: 2_000_000 })),
        restoresInLast24h: fc.integer({ min: 0, max: 10 }),
        nowMs: fc.constant(1_000_000),
        force: fc.boolean(),
        live: fc.oneof(fc.constant(null), liveArb),
    });

    it('never restores through any hard safety gate, even with force', () => {
        fc.assert(
            fc.property(inputArb, (input) => {
                const d = evaluateRestore(input, cfg);
                if (d.action !== 'restore') return;
                // Each of these would mean fighting another system or overriding a human.
                expect(input.managementState).toBe('managed');
                expect(input.live).not.toBeNull();
                expect(input.live!.desiredCount).toBeGreaterThan(0);
                expect(input.live!.status).toBe('ACTIVE');
                expect(input.live!.deploymentInProgress).toBe(false);
                expect(hasSpotProvider(input.live!.currentStrategy)).toBe(true);
                expect(input.restoresInLast24h).toBeLessThan(cfg.maxRestoresPerServicePerDay);
                expect(input.desiredStrategy.length).toBeGreaterThan(0);
            }),
        );
    });

    it('force affects the backoff gate and nothing else', () => {
        fc.assert(
            fc.property(inputArb, (input) => {
                const forced = evaluateRestore({ ...input, force: true }, cfg);
                const unforced = evaluateRestore({ ...input, force: false }, cfg);
                // The only way the two may differ is the backoff skip.
                if (forced.action !== unforced.action) {
                    expect(unforced).toEqual({ action: 'skip', reason: 'backoff' });
                }
            }),
        );
    });

    it('every strategy it emits is restorable (never a silent no-op update)', () => {
        // Regression: an earlier version returned 'restore' when the saved baseline
        // contained NO Spot provider, producing an UpdateService that placed nothing on
        // Spot — a pointless forceNewDeployment plus a "restoring to Spot" alert that
        // was a lie. fast-check found it via desiredStrategy [{EC2, weight 0}] against a
        // live service in fallback. Asserted over the UNCONSTRAINED arbitrary so that
        // hole cannot come back.
        fc.assert(
            fc.property(inputArb, (input) => {
                const d = evaluateRestore(input, cfg);
                if (d.action !== 'restore') return;
                expect(isSpotFirstState(d.strategy)).toBe(true);
            }),
        );
    });

    it('refuses to restore when the saved baseline has no Spot provider', () => {
        fc.assert(
            fc.property(
                fc.record({
                    managementState: fc.constant('managed' as const),
                    // No Spot provider anywhere in the baseline.
                    desiredStrategy: fc
                        .uniqueArray(onDemandProviderName, { minLength: 1, maxLength: 3 })
                        .map((names) => names.map((n) => ({ capacityProvider: n, weight: 0, base: 0 }))),
                    restorePending: fc.constant(true),
                    backoffUntilMs: fc.constant(null),
                    restoresInLast24h: fc.constant(0),
                    nowMs: fc.constant(1_000_000),
                    force: fc.boolean(),
                    live: fc.record({
                        currentStrategy: fallbackStrategyArb,
                        desiredCount: fc.integer({ min: 1, max: 20 }),
                        status: fc.constant('ACTIVE'),
                        hasLoadBalancers: fc.boolean(),
                        deploymentInProgress: fc.constant(false),
                    }),
                }),
                (input) => {
                    expect(evaluateRestore(input, cfg)).toEqual({
                        action: 'skip',
                        reason: 'desired_strategy_not_restorable',
                    });
                },
            ),
        );
    });

    it('restores whenever every gate is satisfied (the arbitrary guarantees they are)', () => {
        // Asserts the positive case directly instead of filtering for it with fc.pre,
        // which previously starved the run and tested nothing.
        fc.assert(
            fc.property(restorableInputArb, (input) => {
                const d = evaluateRestore(input, cfg);
                expect(d.action).toBe('restore');
                if (d.action !== 'restore') return;
                expect(isSpotFirstState(d.strategy)).toBe(true);
                expect(d.enforceAlbDelay).toBe(input.live.hasLoadBalancers);
            }),
        );
    });

    it('is stable under repetition: re-evaluating its own output asks for no further persist', () => {
        fc.assert(
            fc.property(restorableInputArb, (input) => {
                const first = evaluateRestore(input, cfg);
                expect(first.action).toBe('restore');
                if (first.action !== 'restore') return;
                const second = evaluateRestore({ ...input, desiredStrategy: first.strategy }, cfg);
                expect(second.action).toBe('restore');
                if (second.action !== 'restore') return;
                // Second pass must be a fixed point — otherwise the hourly job would
                // rewrite the stored baseline forever, once per hour, for no reason.
                expect(second.persistDesiredStrategy).toBe(false);
                expect(strategyEquals(second.strategy, first.strategy)).toBe(true);
            }),
        );
    });
});

describe('computeBackoffUntil properties', () => {
    it('is monotonic non-decreasing in the failure count and always finite', () => {
        fc.assert(
            fc.property(fc.integer({ min: 1, max: 100 }), (n) => {
                const a = computeBackoffUntil(n, 0, cfg).getTime();
                const b = computeBackoffUntil(n + 1, 0, cfg).getTime();
                expect(Number.isFinite(a)).toBe(true);
                expect(b).toBeGreaterThanOrEqual(a);
            }),
        );
    });

    it('never exceeds the configured maximum and never precedes now', () => {
        fc.assert(
            fc.property(fc.integer({ min: -10, max: 1_000_000 }), fc.integer({ min: 0, max: 1e12 }), (n, now) => {
                const t = computeBackoffUntil(n, now, cfg).getTime();
                expect(t).toBeGreaterThanOrEqual(now + cfg.backoffBaseMs);
                expect(t).toBeLessThanOrEqual(now + cfg.backoffMaxMs);
            }),
        );
    });
});
