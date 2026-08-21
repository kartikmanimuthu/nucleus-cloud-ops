// workers/src/jobs/spot-guard/services/engine.test.ts
//
// Example-based tests for the Spot Guard decision core.
//
// The "BUG FIX" blocks are regression tests for defects found in the reference CDK
// implementation (cdk-ecs-fargate-spot-automation) that this port deliberately does
// not reproduce. Each names the original failure mode so a future reader can tell
// these apart from ordinary unit tests — and so nobody "simplifies" one away.
import { describe, it, expect } from 'vitest';
import { SPOT_GUARD_CONFIG } from '../config.js';
import type { CapacityProviderStrategyItem, LiveServiceState } from '../types.js';
import {
    buildFallbackStrategy,
    buildSpotFirstStrategy,
    classifyCapacity,
    computeBackoffUntil,
    deriveCapacityState,
    deriveCapacityTransition,
    evaluatePlacementFailure,
    evaluateRestore,
    hasSpotProvider,
    isFallbackState,
    isRestorableStrategy,
    isSpotFirstState,
    isSpotProvider,
    strategyEquals,
} from './engine.js';

const cfg = SPOT_GUARD_CONFIG;

const SPOT_FIRST: CapacityProviderStrategyItem[] = [
    { capacityProvider: 'FARGATE', weight: 0, base: 0 },
    { capacityProvider: 'FARGATE_SPOT', weight: 100, base: 1 },
];

const IN_FALLBACK: CapacityProviderStrategyItem[] = [
    { capacityProvider: 'FARGATE', weight: 10, base: 0 },
    { capacityProvider: 'FARGATE_SPOT', weight: 0, base: 0 },
];

function live(overrides: Partial<LiveServiceState> = {}): LiveServiceState {
    return {
        currentStrategy: IN_FALLBACK,
        desiredCount: 2,
        status: 'ACTIVE',
        hasLoadBalancers: true,
        deploymentInProgress: false,
        ...overrides,
    };
}

// ── Provider classification ───────────────────────────────────────────────────

describe('isSpotProvider', () => {
    it('matches FARGATE_SPOT and custom spot-named providers, case-insensitively', () => {
        expect(isSpotProvider('FARGATE_SPOT')).toBe(true);
        expect(isSpotProvider('my-spot-asg')).toBe(true);
        expect(isSpotProvider('Spot')).toBe(true);
    });

    it('does not match On-Demand providers', () => {
        expect(isSpotProvider('FARGATE')).toBe(false);
        expect(isSpotProvider('EC2')).toBe(false);
        expect(isSpotProvider('')).toBe(false);
    });

    it('matches substrings such as SPOTLIGHT — documented, deliberate behaviour', () => {
        // The reference used a substring match, so a provider literally named
        // "spotlight-cp" would be treated as Spot. Preserved rather than tightened:
        // changing it would silently reclassify a customer's existing provider.
        expect(isSpotProvider('spotlight-cp')).toBe(true);
    });
});

describe('classifyCapacity', () => {
    it('treats absent/unknown capacity provider as on_demand', () => {
        expect(classifyCapacity(undefined)).toBe('on_demand');
        expect(classifyCapacity(null)).toBe('on_demand');
        expect(classifyCapacity('FARGATE')).toBe('on_demand');
        expect(classifyCapacity('FARGATE_SPOT')).toBe('spot');
    });
});

// ── Strategy builders ─────────────────────────────────────────────────────────

describe('buildFallbackStrategy', () => {
    it('zeroes Spot weight and sets On-Demand weight to the configured fallback weight', () => {
        const out = buildFallbackStrategy(SPOT_FIRST, cfg);
        expect(out.find((c) => c.capacityProvider === 'FARGATE_SPOT')).toEqual({
            capacityProvider: 'FARGATE_SPOT',
            weight: 0,
            base: 0,
        });
        expect(out.find((c) => c.capacityProvider === 'FARGATE')?.weight).toBe(cfg.fallbackOnDemandWeight);
    });

    it('KEEPS Spot in the strategy at weight 0 so fallback state stays detectable', () => {
        // Removing Spot would make an automated fallback indistinguishable from a
        // deliberate opt-out, and the service would never be restored.
        const out = buildFallbackStrategy(SPOT_FIRST, cfg);
        expect(hasSpotProvider(out)).toBe(true);
        expect(isFallbackState(out)).toBe(true);
    });

    it('BUG FIX: preserves an On-Demand base guarantee', () => {
        // The reference hardcoded base:0 on BOTH branches and its reverter only ever
        // rewrote `weight`, so an On-Demand `base: 2` capacity guarantee was destroyed
        // on the first fallback and never restored.
        const withBase: CapacityProviderStrategyItem[] = [
            { capacityProvider: 'FARGATE', weight: 0, base: 2 },
            { capacityProvider: 'FARGATE_SPOT', weight: 100, base: 0 },
        ];
        const out = buildFallbackStrategy(withBase, cfg);
        expect(out.find((c) => c.capacityProvider === 'FARGATE')?.base).toBe(2);
    });

    it('reproduces the old behaviour when preserveOnDemandBase is disabled', () => {
        const withBase: CapacityProviderStrategyItem[] = [
            { capacityProvider: 'FARGATE', weight: 0, base: 2 },
            { capacityProvider: 'FARGATE_SPOT', weight: 100, base: 0 },
        ];
        const out = buildFallbackStrategy(withBase, { ...cfg, preserveOnDemandBase: false });
        expect(out.find((c) => c.capacityProvider === 'FARGATE')?.base).toBe(0);
    });
});

describe('buildSpotFirstStrategy', () => {
    it('revives a zero-weighted Spot provider and zeroes On-Demand weight', () => {
        const out = buildSpotFirstStrategy(IN_FALLBACK, cfg);
        expect(out.find((c) => c.capacityProvider === 'FARGATE_SPOT')?.weight).toBe(cfg.restoreSpotMinWeight);
        expect(out.find((c) => c.capacityProvider === 'FARGATE')?.weight).toBe(0);
    });

    it('preserves an existing higher Spot weight rather than flattening it to 1', () => {
        expect(buildSpotFirstStrategy(SPOT_FIRST, cfg).find((c) => c.capacityProvider === 'FARGATE_SPOT')?.weight).toBe(
            100,
        );
    });

    it('preserves On-Demand base while zeroing its weight', () => {
        const out = buildSpotFirstStrategy(
            [
                { capacityProvider: 'FARGATE', weight: 10, base: 2 },
                { capacityProvider: 'FARGATE_SPOT', weight: 0, base: 0 },
            ],
            cfg,
        );
        const od = out.find((c) => c.capacityProvider === 'FARGATE');
        expect(od).toEqual({ capacityProvider: 'FARGATE', weight: 0, base: 2 });
    });
});

// ── State detection ───────────────────────────────────────────────────────────

describe('state detection', () => {
    it('isFallbackState requires Spot to be present but fully zero-weighted', () => {
        expect(isFallbackState(IN_FALLBACK)).toBe(true);
        expect(isFallbackState(SPOT_FIRST)).toBe(false);
        // Spot absent entirely is NOT fallback — it is a deliberate removal.
        expect(isFallbackState([{ capacityProvider: 'FARGATE', weight: 10 }])).toBe(false);
        expect(isFallbackState([])).toBe(false);
    });

    it('deriveCapacityState distinguishes spot / on_demand / mixed / unknown', () => {
        expect(deriveCapacityState([])).toBe('unknown');
        expect(deriveCapacityState(IN_FALLBACK)).toBe('on_demand');
        expect(deriveCapacityState(SPOT_FIRST)).toBe('spot');
        expect(
            deriveCapacityState([
                { capacityProvider: 'FARGATE', weight: 1 },
                { capacityProvider: 'FARGATE_SPOT', weight: 1 },
            ]),
        ).toBe('mixed');
    });

    it('treats an On-Demand base>0 with weight 0 as active On-Demand capacity', () => {
        // base guarantees tasks even at weight 0, so this really is mixed.
        expect(
            deriveCapacityState([
                { capacityProvider: 'FARGATE', weight: 0, base: 2 },
                { capacityProvider: 'FARGATE_SPOT', weight: 100, base: 0 },
            ]),
        ).toBe('mixed');
    });

    it('deriveCapacityTransition detects recovery and fallback only', () => {
        expect(deriveCapacityTransition('on_demand', 'spot')).toBe('recovery');
        expect(deriveCapacityTransition('spot', 'on_demand')).toBe('fallback');
        expect(deriveCapacityTransition('spot', 'spot')).toBeNull();
        expect(deriveCapacityTransition('unknown', 'spot')).toBeNull();
    });

    it('strategyEquals ignores array order', () => {
        expect(strategyEquals(SPOT_FIRST, [...SPOT_FIRST].reverse())).toBe(true);
        expect(strategyEquals(SPOT_FIRST, IN_FALLBACK)).toBe(false);
    });

    it('strategyEquals treats an absent weight/base as 0', () => {
        expect(
            strategyEquals([{ capacityProvider: 'FARGATE' }], [{ capacityProvider: 'FARGATE', weight: 0, base: 0 }]),
        ).toBe(true);
    });
});

// ── Backoff ───────────────────────────────────────────────────────────────────

describe('computeBackoffUntil', () => {
    it('first failure keeps the reference implementation 3-hour delay', () => {
        expect(computeBackoffUntil(1, 0, cfg).getTime()).toBe(cfg.backoffBaseMs);
    });

    it('escalates exponentially and clamps at the configured maximum', () => {
        expect(computeBackoffUntil(2, 0, cfg).getTime()).toBe(cfg.backoffBaseMs * 2);
        expect(computeBackoffUntil(3, 0, cfg).getTime()).toBe(cfg.backoffBaseMs * 4);
        expect(computeBackoffUntil(99, 0, cfg).getTime()).toBe(cfg.backoffMaxMs);
    });

    it('does not overflow to Infinity or NaN on absurd input', () => {
        const t = computeBackoffUntil(1e9, 0, cfg).getTime();
        expect(Number.isFinite(t)).toBe(true);
        expect(t).toBe(cfg.backoffMaxMs);
    });

    it('treats 0 and negative failure counts as the first failure', () => {
        expect(computeBackoffUntil(0, 0, cfg).getTime()).toBe(cfg.backoffBaseMs);
        expect(computeBackoffUntil(-5, 0, cfg).getTime()).toBe(cfg.backoffBaseMs);
    });
});

// ── Placement failure ─────────────────────────────────────────────────────────

describe('evaluatePlacementFailure', () => {
    it('applies fallback and snapshots the good strategy for restore', () => {
        const d = evaluatePlacementFailure({ currentStrategy: SPOT_FIRST, serviceStatus: 'ACTIVE' }, cfg);
        expect(d.action).toBe('apply_fallback');
        if (d.action !== 'apply_fallback') throw new Error('unreachable');
        expect(d.persistDesiredStrategy).toBe(true);
        expect(d.desiredStrategy).toEqual(SPOT_FIRST);
        expect(isFallbackState(d.fallbackStrategy)).toBe(true);
    });

    it('skips a launchType-only service with no capacityProviderStrategy', () => {
        const d = evaluatePlacementFailure({ currentStrategy: [] }, cfg);
        expect(d).toMatchObject({ action: 'skip', reason: 'no_capacity_provider_strategy', stampBackoff: false });
    });

    it('skips a service whose strategy contains no Spot provider', () => {
        const d = evaluatePlacementFailure({ currentStrategy: [{ capacityProvider: 'FARGATE', weight: 1 }] }, cfg);
        expect(d).toMatchObject({ action: 'skip', reason: 'no_spot_provider' });
    });

    it('skips a non-ACTIVE service', () => {
        const d = evaluatePlacementFailure({ currentStrategy: SPOT_FIRST, serviceStatus: 'DRAINING' }, cfg);
        expect(d).toMatchObject({ action: 'skip', reason: 'service_inactive' });
    });

    it('is idempotent: never re-applies fallback to a service already in fallback', () => {
        const d = evaluatePlacementFailure({ currentStrategy: IN_FALLBACK, serviceStatus: 'ACTIVE' }, cfg);
        expect(d).toMatchObject({ action: 'skip', reason: 'already_on_demand' });
    });

    it('BUG FIX: never overwrites the saved good strategy with the failed one', () => {
        // Persisting a Spot-weight-0 strategy as desiredStrategy is the one
        // unrecoverable bug here: the hourly job would then forever "restore" the
        // service to On-Demand and it would silently never see Spot pricing again.
        const d = evaluatePlacementFailure({ currentStrategy: IN_FALLBACK, serviceStatus: 'ACTIVE' }, cfg);
        expect(d.persistDesiredStrategy).toBe(false);
    });

    it('BUG FIX: arms the backoff when a placement failure arrives during fallback', () => {
        // The reference stamped last_failed_ts ONLY when its own UpdateService call
        // threw — never when the asynchronous placement failure that actually followed
        // arrived. So Spot→fail→OD→(next hour)→Spot→fail looped forever. A failure
        // reaching us while already in fallback IS the signal the last restore failed.
        const d = evaluatePlacementFailure({ currentStrategy: IN_FALLBACK, serviceStatus: 'ACTIVE' }, cfg);
        expect(d.stampBackoff).toBe(true);
    });

    it('stamps the backoff on the apply path too', () => {
        const d = evaluatePlacementFailure({ currentStrategy: SPOT_FIRST }, cfg);
        expect(d.stampBackoff).toBe(true);
    });

    it('skips while a deployment is mid-rollout (Cost Scheduler collision guard)', () => {
        const d = evaluatePlacementFailure({ currentStrategy: SPOT_FIRST, deploymentInProgress: true }, cfg);
        expect(d).toMatchObject({ action: 'skip', reason: 'deployment_in_progress', stampBackoff: true });
    });
});

// ── Restore ───────────────────────────────────────────────────────────────────

describe('evaluateRestore', () => {
    const base = {
        managementState: 'managed' as const,
        desiredStrategy: SPOT_FIRST,
        restorePending: true,
        backoffUntilMs: null,
        restoresInLast24h: 0,
        nowMs: 1_000_000,
        live: live(),
    };

    it('restores a service that is owed one', () => {
        const d = evaluateRestore(base, cfg);
        expect(d.action).toBe('restore');
        if (d.action !== 'restore') throw new Error('unreachable');
        expect(isSpotFirstState(d.strategy)).toBe(true);
        expect(d.enforceAlbDelay).toBe(true);
    });

    it('self-heals: restores when the live service is in fallback even without restorePending', () => {
        const d = evaluateRestore({ ...base, restorePending: false }, cfg);
        expect(d.action).toBe('restore');
    });

    it('does nothing when the service is already Spot-first and nothing is pending', () => {
        const d = evaluateRestore(
            { ...base, restorePending: false, live: live({ currentStrategy: SPOT_FIRST }) },
            cfg,
        );
        expect(d).toEqual({ action: 'skip', reason: 'nothing_to_do' });
    });

    it.each([
        ['unmanaged', { managementState: 'unmanaged' as const }, 'unmanaged'],
        ['opted_out', { managementState: 'opted_out' as const }, 'unmanaged'],
        ['inside backoff', { backoffUntilMs: 2_000_000 }, 'backoff'],
        ['no saved strategy', { desiredStrategy: [] }, 'no_desired_strategy'],
        ['service missing', { live: null }, 'service_not_found'],
        ['scaled to zero', { live: live({ desiredCount: 0 }) }, 'scheduler_protection'],
        ['not ACTIVE', { live: live({ status: 'DRAINING' }) }, 'service_inactive'],
        ['mid-rollout', { live: live({ deploymentInProgress: true }) }, 'deployment_in_progress'],
        [
            'Spot deliberately removed',
            { live: live({ currentStrategy: [{ capacityProvider: 'FARGATE', weight: 10 }] }) },
            'governance_spot_removed',
        ],
        ['restore cap reached', { restoresInLast24h: cfg.maxRestoresPerServicePerDay }, 'restore_cap_reached'],
    ])('skips when %s', (_label, overrides, reason) => {
        expect(evaluateRestore({ ...base, ...overrides }, cfg)).toEqual({ action: 'skip', reason });
    });

    it('scheduler protection takes precedence over a pending restore', () => {
        // The Cost Scheduler scaling a service to 0 must win over Spot Guard wanting
        // to restore it — otherwise the two features fight over the same service.
        const d = evaluateRestore({ ...base, restorePending: true, live: live({ desiredCount: 0 }) }, cfg);
        expect(d).toEqual({ action: 'skip', reason: 'scheduler_protection' });
    });

    it('BUG FIX: signals that hardening must be persisted', () => {
        // The reference hardened its strategy in memory only and never wrote it back,
        // so it recomputed the same fix from stale input every hour forever.
        const stale: CapacityProviderStrategyItem[] = [
            { capacityProvider: 'FARGATE', weight: 10, base: 0 },
            { capacityProvider: 'FARGATE_SPOT', weight: 0, base: 0 },
        ];
        const d = evaluateRestore({ ...base, desiredStrategy: stale }, cfg);
        expect(d.action).toBe('restore');
        if (d.action !== 'restore') throw new Error('unreachable');
        expect(d.persistDesiredStrategy).toBe(true);
        expect(isSpotFirstState(d.strategy)).toBe(true);
    });

    it('does not ask for a persist when the stored strategy is already hardened', () => {
        const d = evaluateRestore(base, cfg);
        if (d.action !== 'restore') throw new Error('unreachable');
        expect(d.persistDesiredStrategy).toBe(false);
    });

    it('force bypasses backoff', () => {
        const d = evaluateRestore({ ...base, backoffUntilMs: 2_000_000, force: true }, cfg);
        expect(d.action).toBe('restore');
    });

    it.each([
        ['scheduler protection', { live: live({ desiredCount: 0 }) }, 'scheduler_protection'],
        ['governance', { live: live({ currentStrategy: [{ capacityProvider: 'FARGATE', weight: 10 }] }) }, 'governance_spot_removed'],
        ['unmanaged', { managementState: 'unmanaged' as const }, 'unmanaged'],
        ['restore cap', { restoresInLast24h: 99 }, 'restore_cap_reached'],
    ])('force does NOT bypass %s', (_label, overrides, reason) => {
        const d = evaluateRestore({ ...base, ...overrides, backoffUntilMs: 2_000_000, force: true }, cfg);
        expect(d).toEqual({ action: 'skip', reason });
    });

    it('refuses to restore to a saved baseline that contains no Spot provider', () => {
        // Found by fast-check. The live service is in fallback (so the self-heal branch
        // fires and governance passes), but the stored baseline has drifted to
        // Spot-less — so hardening it yields a strategy that places nothing on Spot.
        // Restoring would be a no-op UpdateService that still bounces every task and
        // still emits a "restoring to Spot" alert. Must skip instead.
        const d = evaluateRestore(
            { ...base, desiredStrategy: [{ capacityProvider: 'EC2', weight: 0, base: 0 }] },
            cfg,
        );
        expect(d).toEqual({ action: 'skip', reason: 'desired_strategy_not_restorable' });
    });

    it('omits the ALB delay step for a service with no load balancer', () => {
        const d = evaluateRestore({ ...base, live: live({ hasLoadBalancers: false }) }, cfg);
        if (d.action !== 'restore') throw new Error('unreachable');
        expect(d.enforceAlbDelay).toBe(false);
    });
});

describe('isRestorableStrategy', () => {
    it('rejects a strategy that would place nothing on Spot', () => {
        expect(isRestorableStrategy(IN_FALLBACK)).toBe(false);
        expect(isRestorableStrategy([{ capacityProvider: 'FARGATE', weight: 10 }])).toBe(false);
        expect(isRestorableStrategy(SPOT_FIRST)).toBe(true);
    });
});
