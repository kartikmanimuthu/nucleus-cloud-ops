// workers/src/jobs/spot-guard/services/engine.ts
//
// Spot Guard decision core (SG-002). Pure & deterministic — no I/O, no AWS SDK, no
// clock reads (nowMs is always injected). Every decision the reference CDK/Python
// Lambdas made inline lives here so it is unit- and property-testable, and so the
// handlers stay thin.
//
// This module is where the fixes for the reference implementation's bugs live. Each is
// marked "BUG FIX" with what went wrong, and each has a named regression test in
// engine.test.ts plus, where it is expressible as an invariant, a property in
// engine.property.test.ts.
import type {
    CapacityProviderStrategyItem,
    CapacityState,
    CapacityType,
    LiveServiceState,
    ManagementState,
} from '../types.js';
import type { SpotGuardConfig } from '../config.js';

// ── Provider classification ───────────────────────────────────────────────────

/**
 * Spot detection: case-insensitive substring match on the capacity provider NAME.
 *
 * Ports `"spot" in cp["capacityProvider"].lower()` (placement-failure index.py:103)
 * and `"SPOT" in cp_name.upper()` (reverter index.py:172). Deliberately matches both
 * `FARGATE_SPOT` and any custom EC2 capacity provider whose name contains "spot",
 * which is how the reference supported ASG-backed Spot providers.
 */
export function isSpotProvider(capacityProvider: string): boolean {
    return /spot/i.test(capacityProvider);
}

export function splitStrategy(strategy: CapacityProviderStrategyItem[]): {
    spot: CapacityProviderStrategyItem[];
    onDemand: CapacityProviderStrategyItem[];
} {
    const spot: CapacityProviderStrategyItem[] = [];
    const onDemand: CapacityProviderStrategyItem[] = [];
    for (const cp of strategy) {
        if (isSpotProvider(cp.capacityProvider)) spot.push(cp);
        else onDemand.push(cp);
    }
    return { spot, onDemand };
}

export function hasSpotProvider(strategy: CapacityProviderStrategyItem[]): boolean {
    return strategy.some((cp) => isSpotProvider(cp.capacityProvider));
}

/**
 * Classify a single task's capacity from its event fields.
 * `UNKNOWN`/absent capacity provider falls through to on_demand, matching the
 * reference's get_capacity_provider() → is_spot() behaviour (observer index.py:69-79).
 */
export function classifyCapacity(capacityProvider?: string | null): CapacityType {
    return capacityProvider && isSpotProvider(capacityProvider) ? 'spot' : 'on_demand';
}

// ── Strategy builders ─────────────────────────────────────────────────────────

/**
 * Fallback strategy: every Spot provider → weight 0, every non-Spot → weight 10.
 * Ports placement-failure index.py:184-202.
 *
 * It deliberately KEEPS the Spot providers in the strategy at weight 0 rather than
 * removing them. That is load-bearing in two places: it is the only on-service signal
 * that distinguishes an automated fallback from a deliberate human opt-out
 * (isFallbackState vs. hasSpotProvider), and it is what the governance check reads to
 * decide whether re-adding Spot is allowed. Removing them would make the two
 * indistinguishable and the service would never be restored.
 *
 * BUG FIX: the reference hardcoded `base: 0` on BOTH branches, and its reverter only
 * ever rewrote `weight` — so an On-Demand `base: N` guaranteed-capacity setting was
 * silently destroyed on the first fallback and never restored. preserveOnDemandBase
 * keeps it.
 */
export function buildFallbackStrategy(
    strategy: CapacityProviderStrategyItem[],
    config: Pick<SpotGuardConfig, 'fallbackOnDemandWeight' | 'preserveOnDemandBase'>,
): CapacityProviderStrategyItem[] {
    const { spot, onDemand } = splitStrategy(strategy);
    return [
        ...spot.map((cp) => ({ capacityProvider: cp.capacityProvider, weight: 0, base: 0 })),
        ...onDemand.map((cp) => ({
            capacityProvider: cp.capacityProvider,
            weight: config.fallbackOnDemandWeight,
            base: config.preserveOnDemandBase ? (cp.base ?? 0) : 0,
        })),
    ];
}

/**
 * The Spot-first "gold standard": every Spot provider gets weight ≥ 1, every non-Spot
 * provider is zeroed. Ports the reverter's hardening block (index.py:169-187).
 *
 * BUG FIX: the reference mutated its local `row["config"]` dict and never wrote it
 * back to DynamoDB — so the hardening it documented as persistent was recomputed from
 * the same stale input every hour. Callers here compare the result against the stored
 * desiredStrategy (via strategyEquals) and PERSIST it when it differs.
 *
 * `base` is preserved rather than zeroed: zeroing an On-Demand weight while leaving
 * base: N means the service keeps N guaranteed On-Demand tasks and places everything
 * above N on Spot. That is the safe reading of "prefer Spot", and it is what makes
 * this composable with preserveOnDemandBase above.
 */
export function buildSpotFirstStrategy(
    strategy: CapacityProviderStrategyItem[],
    config: Pick<SpotGuardConfig, 'restoreSpotMinWeight'>,
): CapacityProviderStrategyItem[] {
    // A DELIBERATE SPLIT is preserved verbatim.
    //
    // Zeroing every non-Spot provider is right for the classic Spot-first baseline, but it
    // destroys an intentional blend — a service configured 50/50 for production would restore as
    // Spot 50 / On-Demand 0, i.e. fully on Spot, which is the opposite of what the operator asked
    // for and a genuine availability change made silently.
    //
    // Both weights being non-zero is a safe signal of intent: the fallback path never writes a
    // baseline while the service is in fallback (that invariant is what stops a failed config
    // being saved as the good one), so a stored baseline with Spot > 0 AND non-Spot > 0 can only
    // have come from someone choosing it.
    //
    // A baseline with Spot at 0 is NOT a split — it is a degenerate or drifted one, so it still
    // gets the original hardening: floor Spot at the minimum, zero everything else.
    if (isDeliberateSplit(strategy)) {
        return strategy.map((cp) => ({
            capacityProvider: cp.capacityProvider,
            weight: isSpotProvider(cp.capacityProvider)
                ? Math.max(cp.weight ?? 0, config.restoreSpotMinWeight)
                : (cp.weight ?? 0),
            base: cp.base ?? 0,
        }));
    }

    return strategy.map((cp) =>
        isSpotProvider(cp.capacityProvider)
            ? {
                  capacityProvider: cp.capacityProvider,
                  weight: Math.max(cp.weight ?? 0, config.restoreSpotMinWeight),
                  base: cp.base ?? 0,
              }
            : { capacityProvider: cp.capacityProvider, weight: 0, base: cp.base ?? 0 },
    );
}

/**
 * True when the strategy blends Spot and non-Spot on purpose: at least one Spot provider and at
 * least one non-Spot provider, both carrying weight.
 *
 * Deliberately NOT the inverse of isFallbackState — fallback is "Spot present but zero-weighted",
 * so a fallback strategy is not a split, which is what keeps restore from treating a fallen-back
 * service as an intentional blend and leaving it on On-Demand forever.
 */
export function isDeliberateSplit(strategy: CapacityProviderStrategyItem[]): boolean {
    const spotWeighted = strategy.some((cp) => isSpotProvider(cp.capacityProvider) && (cp.weight ?? 0) > 0);
    const onDemandWeighted = strategy.some((cp) => !isSpotProvider(cp.capacityProvider) && (cp.weight ?? 0) > 0);
    return spotWeighted && onDemandWeighted;
}

// ── State detection ───────────────────────────────────────────────────────────

/**
 * Fallback state: Spot is present in the strategy but every Spot provider sits at
 * weight 0. Unifies two subtly different expressions in the reference — the reverter's
 * `is_fallback` (index.py:257) and the placement-failure handler's idempotency probe
 * (index.py:171-174) — which is exactly the kind of drift that made the original hard
 * to reason about.
 */
export function isFallbackState(strategy: CapacityProviderStrategyItem[]): boolean {
    const { spot } = splitStrategy(strategy);
    return spot.length > 0 && spot.every((cp) => (cp.weight ?? 0) === 0);
}

/** At least one Spot provider is actually eligible to place tasks. */
export function isSpotFirstState(strategy: CapacityProviderStrategyItem[]): boolean {
    return splitStrategy(strategy).spot.some((cp) => (cp.weight ?? 0) > 0);
}

export function deriveCapacityState(strategy: CapacityProviderStrategyItem[]): CapacityState {
    if (strategy.length === 0) return 'unknown';
    if (isFallbackState(strategy)) return 'on_demand';
    const { spot, onDemand } = splitStrategy(strategy);
    const activeSpot = spot.some((cp) => (cp.weight ?? 0) > 0);
    const activeOnDemand = onDemand.some((cp) => (cp.weight ?? 0) > 0 || (cp.base ?? 0) > 0);
    if (activeSpot && activeOnDemand) return 'mixed';
    if (activeSpot) return 'spot';
    return 'on_demand';
}

/**
 * Spot↔On-Demand transition for a running service, used to raise recovery/fallback
 * alerts. Ports observer index.py:151-156. Note it is indifferent to WHO changed the
 * capacity, so a manual human switch is alerted the same as an automated one — that
 * was deliberate in the reference and is preserved.
 */
export function deriveCapacityTransition(
    previous: CapacityType | 'unknown',
    next: CapacityType,
): 'recovery' | 'fallback' | null {
    if (previous === 'on_demand' && next === 'spot') return 'recovery';
    if (previous === 'spot' && next === 'on_demand') return 'fallback';
    return null;
}

/** Order-insensitive structural comparison — ECS does not guarantee array order. */
export function strategyEquals(
    a: CapacityProviderStrategyItem[],
    b: CapacityProviderStrategyItem[],
): boolean {
    if (a.length !== b.length) return false;
    const normalize = (s: CapacityProviderStrategyItem[]) =>
        s
            .map((cp) => `${cp.capacityProvider}:${cp.weight ?? 0}:${cp.base ?? 0}`)
            .sort()
            .join('|');
    return normalize(a) === normalize(b);
}

// ── Backoff ───────────────────────────────────────────────────────────────────

/**
 * Capped exponential backoff. `Math.min` is applied before the multiply cannot
 * overflow, and the exponent is clamped, so a pathological consecutiveFailures (say
 * 5000) yields backoffMaxMs rather than Infinity/NaN.
 */
export function computeBackoffUntil(
    consecutiveFailures: number,
    nowMs: number,
    config: Pick<SpotGuardConfig, 'backoffBaseMs' | 'backoffMaxMs'>,
): Date {
    const n = Math.max(1, Math.floor(consecutiveFailures));
    // Cap the exponent so 2 ** n stays finite regardless of input.
    const exponent = Math.min(n - 1, 32);
    const delay = Math.min(config.backoffBaseMs * 2 ** exponent, config.backoffMaxMs);
    return new Date(nowMs + delay);
}

// ── Placement-failure decision ────────────────────────────────────────────────

export type FallbackSkipReason =
    | 'no_capacity_provider_strategy'
    | 'already_on_demand'
    | 'service_inactive'
    | 'deployment_in_progress'
    | 'no_spot_provider';

export type FallbackDecision =
    | {
          action: 'skip';
          reason: FallbackSkipReason;
          persistDesiredStrategy: false;
          stampBackoff: boolean;
      }
    | {
          action: 'apply_fallback';
          fallbackStrategy: CapacityProviderStrategyItem[];
          /** The good Spot-first strategy to snapshot for later restore. */
          desiredStrategy: CapacityProviderStrategyItem[];
          persistDesiredStrategy: true;
          stampBackoff: true;
      };

export function evaluatePlacementFailure(
    input: {
        currentStrategy: CapacityProviderStrategyItem[];
        serviceStatus?: string | null;
        deploymentInProgress?: boolean;
    },
    config: Pick<SpotGuardConfig, 'fallbackOnDemandWeight' | 'preserveOnDemandBase'>,
): FallbackDecision {
    // A launchType-based service has no strategy to rewrite (index.py:162-164).
    if (input.currentStrategy.length === 0) {
        return {
            action: 'skip',
            reason: 'no_capacity_provider_strategy',
            persistDesiredStrategy: false,
            stampBackoff: false,
        };
    }
    if (input.serviceStatus && input.serviceStatus !== 'ACTIVE') {
        return { action: 'skip', reason: 'service_inactive', persistDesiredStrategy: false, stampBackoff: false };
    }
    if (!hasSpotProvider(input.currentStrategy)) {
        return { action: 'skip', reason: 'no_spot_provider', persistDesiredStrategy: false, stampBackoff: false };
    }

    // IDEMPOTENCY GUARD (index.py:169-178) — two coupled obligations:
    //
    //   1. Do NOT call UpdateService again. A second forceNewDeployment bounces every
    //      task in the service for no benefit.
    //   2. Do NOT persist this strategy as desiredStrategy. Saving a Spot-weight-0
    //      strategy as the restore baseline is the ONE unrecoverable bug in this
    //      feature: the hourly job would then forever "restore" the service to
    //      On-Demand, and it would silently never return to Spot pricing again. This
    //      is why the reference has an explicit `continue` before its put_item, and
    //      why persistDesiredStrategy is false here.
    //
    // BUG FIX: stampBackoff is TRUE on this branch. The reference wrote
    // last_failed_ts only when its own UpdateService call threw, never when the
    // ASYNCHRONOUS placement failure arrived afterwards. But a placement failure
    // reaching us while the service is ALREADY in fallback is precisely the signal
    // that the last restore failed out-of-band — so it must arm the backoff, or
    // Spot→fail→OD→(next hour)→Spot→fail loops indefinitely.
    if (isFallbackState(input.currentStrategy)) {
        return { action: 'skip', reason: 'already_on_demand', persistDesiredStrategy: false, stampBackoff: true };
    }

    // Never stack a capacity change on top of an in-flight rollout — this is also
    // where a collision with the Cost Scheduler's UpdateService would surface.
    if (input.deploymentInProgress) {
        return {
            action: 'skip',
            reason: 'deployment_in_progress',
            persistDesiredStrategy: false,
            stampBackoff: true,
        };
    }

    return {
        action: 'apply_fallback',
        fallbackStrategy: buildFallbackStrategy(input.currentStrategy, config),
        desiredStrategy: input.currentStrategy,
        persistDesiredStrategy: true,
        stampBackoff: true,
    };
}

// ── Restore decision (hourly reverter) ────────────────────────────────────────

export type RestoreSkipReason =
    | 'backoff'
    | 'unmanaged'
    | 'service_not_found'
    | 'scheduler_protection'
    | 'service_inactive'
    | 'deployment_in_progress'
    | 'governance_spot_removed'
    | 'restore_cap_reached'
    | 'nothing_to_do'
    | 'no_desired_strategy'
    | 'desired_strategy_not_restorable';

export type RestoreDecision =
    | { action: 'skip'; reason: RestoreSkipReason }
    | {
          action: 'restore';
          strategy: CapacityProviderStrategyItem[];
          /** True when hardening changed the stored strategy → persist it (BUG FIX). */
          persistDesiredStrategy: boolean;
          enforceAlbDelay: boolean;
      };

export function evaluateRestore(
    input: {
        managementState: ManagementState;
        desiredStrategy: CapacityProviderStrategyItem[];
        restorePending: boolean;
        backoffUntilMs: number | null;
        restoresInLast24h: number;
        nowMs: number;
        force?: boolean;
        /** null when DescribeServices returned no such service (index.py:227-229). */
        live: LiveServiceState | null;
    },
    config: Pick<SpotGuardConfig, 'restoreSpotMinWeight' | 'maxRestoresPerServicePerDay'>,
): RestoreDecision {
    // Order matters: cheapest and most protective checks first.

    if (input.managementState !== 'managed') return { action: 'skip', reason: 'unmanaged' };

    // `force` bypasses ONLY the backoff (the manual "Restore now" button). It must
    // never bypass a safety gate — see the property test asserting exactly that.
    if (!input.force && input.backoffUntilMs !== null && input.backoffUntilMs > input.nowMs) {
        return { action: 'skip', reason: 'backoff' };
    }

    if (input.desiredStrategy.length === 0) return { action: 'skip', reason: 'no_desired_strategy' };
    if (!input.live) return { action: 'skip', reason: 'service_not_found' };

    // SCHEDULER PROTECTION (index.py:237-239). A service at desiredCount 0 was
    // deliberately scaled down — very likely by Nucleus's OWN Cost Scheduler
    // (jobs/scheduler/resource-schedulers/ecs-scheduler.ts). Restoring here would
    // forceNewDeployment a stopped service and fight the scheduler.
    if (input.live.desiredCount === 0) return { action: 'skip', reason: 'scheduler_protection' };
    if (input.live.status !== 'ACTIVE') return { action: 'skip', reason: 'service_inactive' };
    if (input.live.deploymentInProgress) return { action: 'skip', reason: 'deployment_in_progress' };

    // GOVERNANCE (index.py:252-254). Spot is absent from the live strategy entirely,
    // which means an operator removed it on purpose. Never re-add Spot to a service
    // somebody deliberately took off Spot. Distinct from isFallbackState, where Spot
    // is present but zero-weighted.
    if (!hasSpotProvider(input.live.currentStrategy)) {
        return { action: 'skip', reason: 'governance_spot_removed' };
    }

    // Hard circuit breaker. Every restore is a rolling deployment; this caps the
    // damage a flapping AZ can do even if the backoff logic is wrong or forced.
    if (input.restoresInLast24h >= config.maxRestoresPerServicePerDay) {
        return { action: 'skip', reason: 'restore_cap_reached' };
    }

    // Restore when one is owed OR the live service is observably in fallback. The
    // second clause is the self-heal: it covers a fallback applied out-of-band, or a
    // restorePending flag lost to a crash. Ports index.py:260.
    if (!input.restorePending && !isFallbackState(input.live.currentStrategy)) {
        return { action: 'skip', reason: 'nothing_to_do' };
    }

    const hardened = buildSpotFirstStrategy(input.desiredStrategy, config);

    // The saved baseline contains no Spot provider at all, so hardening it cannot
    // produce a strategy that places anything on Spot. Restoring to it would be a
    // silent no-op UpdateService — a pointless forceNewDeployment that bounces every
    // task, counts as a restore, and emits a "restoring to Spot" alert that is a lie.
    //
    // Reachable whenever the live service is in fallback (so the self-heal branch
    // above fires) while the stored desiredStrategy has drifted to Spot-less — e.g. a
    // baseline captured before someone removed Spot, or a hand-edited row.
    //
    // The reference implementation had the same hole and only caught it downstream,
    // inside update_capacity_provider's has_active_spot check, which returned None and
    // logged a warning — invisible to the caller, which had already alerted. Refusing
    // here, in the decision function, keeps the alert honest.
    if (!isRestorableStrategy(hardened)) {
        return { action: 'skip', reason: 'desired_strategy_not_restorable' };
    }

    return {
        action: 'restore',
        strategy: hardened,
        persistDesiredStrategy: !strategyEquals(hardened, input.desiredStrategy),
        enforceAlbDelay: input.live.hasLoadBalancers,
    };
}

// ── Guards used by the mutation path ──────────────────────────────────────────

/**
 * Pre-flight assertion before any restore UpdateService call, ported from the
 * reference's has_active_spot check (index.py:114-122). Refuses to "restore" a service
 * to a strategy that would place nothing on Spot — which would be a silent, expensive
 * no-op that also looks like success.
 */
export function isRestorableStrategy(strategy: CapacityProviderStrategyItem[]): boolean {
    return isSpotFirstState(strategy);
}

/** Whether a mutating reaction to this event is still worth attempting. */
export function isEventActionable(
    eventTimeMs: number,
    nowMs: number,
    config: Pick<SpotGuardConfig, 'maxActionableEventAgeMs'>,
): boolean {
    return nowMs - eventTimeMs <= config.maxActionableEventAgeMs;
}
