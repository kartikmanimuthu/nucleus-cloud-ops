// web-ui/lib/spot-guard/strategy.ts
//
// Capacity-provider strategy builders for the user-initiated Spot Guard actions.
//
// ⚠️  THIS IS A DELIBERATE MIRROR of
//     apps/workers/src/jobs/spot-guard/services/engine.ts
//
// web-ui and workers are separate npm packages and web-ui cannot import from apps/workers,
// so the same logic necessarily exists twice — the repo already accepts this for
// right-sizing (see the header of apps/workers/src/jobs/right-sizing/config.ts).
//
// Drift between the two copies would be genuinely dangerous: the UI could enable Spot with
// one strategy shape while the hourly restore job asserts a different one, producing an
// endless update loop. The guard is a SHARED FIXTURE of input/expected vectors,
// libs/prisma/../__fixtures__ is not the right home for it, so it lives at
// apps/web-ui/lib/spot-guard/__fixtures__/strategy-vectors.json and is loaded by BOTH test
// suites. If you change the logic here, that fixture must change, and the workers test
// fails too — which is the point.
import type { CapacityProviderStrategyItem } from '@/lib/db/repositories/spot-guard/interface';

/** Weight applied to non-Spot providers when falling back. Mirrors SPOT_GUARD_CONFIG. */
export const FALLBACK_ON_DEMAND_WEIGHT = 100;
/** Minimum weight a Spot provider is hardened up to when restoring. */
export const RESTORE_SPOT_MIN_WEIGHT = 1;

/**
 * Spot detection: case-insensitive substring match on the provider NAME.
 * Matches FARGATE_SPOT and any custom capacity provider containing "spot", which is how
 * the reference supported ASG-backed Spot providers.
 */
export function isSpotProvider(capacityProvider: string): boolean {
    return /spot/i.test(capacityProvider);
}

export function hasSpotProvider(strategy: CapacityProviderStrategyItem[]): boolean {
    return strategy.some((cp) => isSpotProvider(cp.capacityProvider));
}

export function splitStrategy(strategy: CapacityProviderStrategyItem[]) {
    return {
        spot: strategy.filter((cp) => isSpotProvider(cp.capacityProvider)),
        onDemand: strategy.filter((cp) => !isSpotProvider(cp.capacityProvider)),
    };
}

/** Spot present but every Spot provider at weight 0 — the automated-fallback signature. */
export function isFallbackState(strategy: CapacityProviderStrategyItem[]): boolean {
    const { spot } = splitStrategy(strategy);
    return spot.length > 0 && spot.every((cp) => (cp.weight ?? 0) === 0);
}

export function isSpotFirstState(strategy: CapacityProviderStrategyItem[]): boolean {
    return splitStrategy(strategy).spot.some((cp) => (cp.weight ?? 0) > 0);
}

export function deriveCapacityState(
    strategy: CapacityProviderStrategyItem[],
): 'spot' | 'on_demand' | 'mixed' | 'unknown' {
    if (strategy.length === 0) return 'unknown';
    if (isFallbackState(strategy)) return 'on_demand';
    const { spot, onDemand } = splitStrategy(strategy);
    const activeSpot = spot.some((cp) => (cp.weight ?? 0) > 0);
    const activeOnDemand = onDemand.some((cp) => (cp.weight ?? 0) > 0 || (cp.base ?? 0) > 0);
    if (activeSpot && activeOnDemand) return 'mixed';
    return activeSpot ? 'spot' : 'on_demand';
}

/**
 * Spot-first "gold standard": every Spot provider gets weight >= 1, every non-Spot provider
 * is zeroed. `base` is preserved, so an On-Demand base: N keeps N guaranteed On-Demand
 * tasks while everything above N goes to Spot — the safe reading of "prefer Spot".
 */
export function buildSpotFirstStrategy(
    strategy: CapacityProviderStrategyItem[],
    opts: { spotWeight?: number; onDemandWeight?: number; onDemandBase?: number } = {},
): CapacityProviderStrategyItem[] {
    const spotWeight = Math.max(opts.spotWeight ?? RESTORE_SPOT_MIN_WEIGHT, 1);
    /**
     * Did the caller state an exact Spot weight, or just a floor?
     *
     * This distinction is load-bearing and was missing. The Spot branch below used to be
     * Math.max(existing, spotWeight) unconditionally — a FLOOR, which is right for the restore path
     * (never restore below restoreSpotMinWeight) but wrong when someone picks a percentage in the
     * Capacity dialog, because a request to LOWER Spot was silently ignored.
     *
     * Observed in sbx: stx-kyc-ekyc-admin-api sat at FARGATE_SPOT w100. Asking for 50% sent
     * spotWeight 50 / onDemandWeight 50, and max(100, 50) kept Spot at 100 — so the service landed
     * on w100/w50, i.e. 67% Spot, and the console honestly reported 67% for a service the operator
     * had just set to 50%.
     *
     * The shared drift vectors never exercise an explicit spotWeight, which is exactly why this
     * survived: the restore path they do cover behaves identically either way.
     */
    const spotWeightIsExact = opts.spotWeight !== undefined;
    // Non-Spot weight, in precedence order:
    //   1. an explicit onDemandWeight — the user asked for a blend (e.g. 50/50 in production);
    //   2. the existing weight, when the input is already a deliberate split, so a restore does
    //      not silently collapse a blend to Spot-only;
    //   3. 0 — the classic Spot-first "gold standard".
    // MUST match apps/workers/src/jobs/spot-guard/services/engine.ts. The shared vectors in
    // __fixtures__/strategy-vectors.json fail on both sides if these drift.
    const preserveSplit = opts.onDemandWeight === undefined && isDeliberateSplit(strategy);
    return strategy.map((cp) =>
        isSpotProvider(cp.capacityProvider)
            ? {
                  capacityProvider: cp.capacityProvider,
                  // Exact when asked for, floored otherwise — see spotWeightIsExact above.
                  weight: spotWeightIsExact ? spotWeight : Math.max(cp.weight ?? 0, spotWeight),
                  base: cp.base ?? 0,
              }
            : {
                  capacityProvider: cp.capacityProvider,
                  weight: opts.onDemandWeight ?? (preserveSplit ? (cp.weight ?? 0) : 0),
                  base: opts.onDemandBase ?? cp.base ?? 0,
              },
    );
}

/**
 * True when the strategy blends Spot and non-Spot on purpose: at least one of each, both weighted.
 *
 * NOT the inverse of isFallbackState — fallback is "Spot present but zero-weighted", so a
 * fallen-back service is not a split. That distinction is what stops restore from mistaking a
 * fallback for an intentional blend and leaving the service on On-Demand.
 */
export function isDeliberateSplit(strategy: CapacityProviderStrategyItem[]): boolean {
    const spotWeighted = strategy.some((cp) => isSpotProvider(cp.capacityProvider) && (cp.weight ?? 0) > 0);
    const onDemandWeighted = strategy.some((cp) => !isSpotProvider(cp.capacityProvider) && (cp.weight ?? 0) > 0);
    return spotWeighted && onDemandWeighted;
}

/**
 * Fallback strategy: Spot -> weight 0, non-Spot -> the fallback weight.
 *
 * Keeps Spot in the strategy at weight 0 rather than removing it — that is the only
 * on-service signal distinguishing an automated fallback from a deliberate opt-out, and
 * removing it would make the service un-restorable. On-Demand `base` is preserved (the
 * reference destroyed it).
 *
 * Also used by the user-facing "Disable Spot" action, which is why it is here and not only
 * in the worker.
 */
export function buildFallbackStrategy(
    strategy: CapacityProviderStrategyItem[],
): CapacityProviderStrategyItem[] {
    const { spot, onDemand } = splitStrategy(strategy);
    return [
        ...spot.map((cp) => ({ capacityProvider: cp.capacityProvider, weight: 0, base: 0 })),
        ...onDemand.map((cp) => ({
            capacityProvider: cp.capacityProvider,
            weight: FALLBACK_ON_DEMAND_WEIGHT,
            base: cp.base ?? 0,
        })),
    ];
}

/**
 * Add a Spot provider to a strategy that has none.
 *
 * Only reachable for a service whose cluster actually offers a Spot provider — the enable
 * mutation verifies that against live AWS first and returns 409 otherwise, because
 * UpdateService rejects a provider the cluster does not have.
 */
export function addSpotProvider(
    strategy: CapacityProviderStrategyItem[],
    spotProviderName: string,
    opts: { spotWeight?: number; onDemandWeight?: number; onDemandBase?: number } = {},
): CapacityProviderStrategyItem[] {
    // Always pass an explicit On-Demand weight, defaulting to 0.
    //
    // buildSpotFirstStrategy preserves an existing non-Spot weight when it looks like a
    // deliberate blend, which is correct for RESTORE (the stored baseline is the operator's
    // recorded intent) but wrong here. "Enable Spot" acts on whatever the service happens to
    // look like right now; a weight it already had is not a blend anyone chose, and inheriting
    // it would leave traffic On-Demand after the user explicitly asked for Spot.
    const explicit = { ...opts, onDemandWeight: opts.onDemandWeight ?? 0 };
    if (hasSpotProvider(strategy)) return buildSpotFirstStrategy(strategy, explicit);
    return buildSpotFirstStrategy(
        [...strategy, { capacityProvider: spotProviderName, weight: explicit.spotWeight ?? 100, base: 0 }],
        explicit,
    );
}

/** Order-insensitive structural comparison — ECS does not guarantee array order. */
export function strategyEquals(
    a: CapacityProviderStrategyItem[],
    b: CapacityProviderStrategyItem[],
): boolean {
    if (a.length !== b.length) return false;
    const norm = (s: CapacityProviderStrategyItem[]) =>
        s.map((cp) => `${cp.capacityProvider}:${cp.weight ?? 0}:${cp.base ?? 0}`).sort().join('|');
    return norm(a) === norm(b);
}
