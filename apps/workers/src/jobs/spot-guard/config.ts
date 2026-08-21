// workers/src/jobs/spot-guard/config.ts
//
// Tunable constants for Fargate Spot Guard (SG-*).
// Structurally mirrors web-ui/lib/spot-guard/config.ts (separate npm package — web-ui
// cannot import from apps/workers, same constraint right-sizing lives with).
//
// Every magic number the reference CDK implementation hardcoded inline lives here.

export const SPOT_GUARD_CONFIG = {
    /** Weight applied to every non-Spot provider when falling back. Ported verbatim. */
    fallbackOnDemandWeight: 100,
    /** Minimum weight a Spot provider is hardened up to when restoring. Ported verbatim. */
    restoreSpotMinWeight: 1,

    /**
     * Preserve an On-Demand `base` (guaranteed task count) across a fallback.
     *
     * The reference implementation hardcoded base:0 on BOTH branches of its fallback
     * builder, and its reverter only ever rewrote `weight` — so an On-Demand
     * `base: 2` capacity guarantee was destroyed on the first fallback and never
     * came back. Defaults true to fix that.
     */
    preserveOnDemandBase: true,

    /**
     * Restore backoff. The reference used a flat 3h (`3 * 3600`). Base is kept at 3h
     * so the FIRST failure behaves identically, then it escalates 3h → 6h → 12h → 24h
     * so a persistently capacity-starved AZ stops burning a rolling deployment every
     * three hours forever.
     */
    backoffBaseMs: 3 * 60 * 60 * 1000,
    backoffMaxMs: 24 * 60 * 60 * 1000,

    /** ALB deregistration delay enforced on managed target groups, in seconds. */
    albDeregistrationDelaySeconds: 60,

    /**
     * Hard circuit breaker: refuse to restore a service more than this many times in
     * a rolling 24h window, regardless of backoff. Every restore is a
     * forceNewDeployment, so this is the last line of defence against thrashing
     * production tasks. The reference implementation had no equivalent.
     */
    maxRestoresPerServicePerDay: 4,

    /**
     * A Spot interruption warning is only actionable for ~120s. Past this age the ALB
     * pre-drain is pointless (the task is already gone), so the mutating branch is
     * skipped while the session/accounting rows are still written — those stay valid
     * at any age. Matters after an outage, when a 4h SQS backlog drains at once.
     */
    maxActionableEventAgeMs: 120 * 1000,

    /** Retention. Two TTLs on one column — see the SpotGuardTaskSession model comment. */
    eventTtlDays: 90,
    closedSessionTtlDays: 90,
    /** Orphan reaper for an open session whose ECS STOPPED event never arrived. */
    openSessionTtlDays: 14,
    actionClaimTtlDays: 2,

    /** Per-tenant fan-out spacing (the atomic tenant_configs claim interval). */
    restoreMinIntervalMs: 55 * 60 * 1000,
    reportMinIntervalMs: 20 * 60 * 60 * 1000,

    /** SQS → pg-boss bridge. */
    eventBatchSize: 20,
    pollWaitSeconds: 20,
    pollBatchSize: 10,

    /** Default report timezone when a tenant has not configured one. */
    defaultReportTimezone: 'UTC',
} as const;

export type SpotGuardConfig = typeof SPOT_GUARD_CONFIG;

/**
 * Slack dedup windows, in seconds, ported verbatim from the reference implementation
 * so alert cadence is unchanged:
 *   interruption      300  interruption-handler index.js:284 + observer index.py:136
 *   placement_failure 300  placement-failure index.py:145  (was "FAILURE#")
 *   remediation       300  placement-failure index.py:218  (was "REMEDIATION#")
 *   fallback          600  observer index.py:156           (was "FALLBACK#")
 *   recovery          600  observer index.py:152           (was "RECOVERY#")
 *   restore_attempt  3600  reverter index.py:265           (was "RESTORE_ATTEMPT#")
 *
 * 0 means "never dedup" — user-initiated actions must always notify.
 *
 * NOTE: these gate SLACK ONLY, never the spot_guard_events row. The reference
 * throttled the alert itself, which was fine with no UI; here the event row is the
 * product surface, and punching holes in the timeline during an incident (exactly
 * when a burst of interruptions is most interesting) would be the wrong trade.
 */
export const DEDUP_WINDOWS_SECONDS = {
    interruption: 300,
    placement_failure: 300,
    remediation: 300,
    fallback: 600,
    recovery: 600,
    restore_attempt: 3600,
    /** New — the reference never alerted on a failed restore at all. */
    restore_failed: 900,
    spot_enabled: 0,
    spot_disabled: 0,
} as const;

export type AlertType = keyof typeof DEDUP_WINDOWS_SECONDS;
