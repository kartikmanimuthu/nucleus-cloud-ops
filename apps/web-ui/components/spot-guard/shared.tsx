"use client";

import { cn } from "@/lib/utils";
import type {
    CapacityState,
    CapacityProviderStrategyItem,
    ManagementState,
    SpotEligibility,
    SpotEventSeverity,
    SpotEventType,
} from "@/lib/db/repositories/spot-guard/interface";

export function formatHours(n: number | null | undefined): string {
    if (n == null) return "—";
    return `${n.toFixed(2)} hrs`;
}

export function formatPercent(share: number | null | undefined): string {
    if (share == null) return "—";
    return `${Math.round(share * 100)}%`;
}

export function formatRelative(iso: string | null | undefined): string {
    if (!iso) return "—";
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return "—";
    const seconds = Math.round((Date.now() - then) / 1000);
    if (seconds < 60) return "just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}

/**
 * Timezone Spot Guard timestamps render in, absent an explicit one from the caller.
 *
 * Matches workers/src/jobs/spot-guard/config.ts's SPOT_GUARD_CONFIG.defaultReportTimezone
 * exactly — that is what the daily-report job falls back to when a tenant's Settings ->
 * Spot Guard "Report timezone" field is empty. An earlier version of this file pinned the
 * constant to Asia/Kolkata unconditionally, so a tenant that left the setting empty (UTC) or
 * set it to a third zone saw the report's day boundary land somewhere the displayed
 * created/updated timestamps did not agree with — two clocks for one feature. Every caller
 * should now pass the tenant's actual `reportTimezone` (from useSpotGuardSettings()) through
 * `tz`; this default only covers a caller that has not been threaded yet.
 */
export const DEFAULT_DISPLAY_TZ = "UTC";

/**
 * Human label for an IANA zone, for the "Timestamps are ⟨label⟩ (⟨tz⟩)" line.
 *
 * A curated name for the couple of zones this product actually uses, so India reads "IST"
 * rather than the ICU short form ("GMT+5:30") — Node's Intl has no CLDR abbreviation for
 * India at all, unlike e.g. America/New_York, which already gets "EST"/"EDT" for free. Any
 * OTHER configured zone falls through to that Intl short form, so a tenant is never shown a
 * bare IANA identifier with no explanation.
 */
const TZ_LABELS: Record<string, string> = { UTC: "UTC", "Asia/Kolkata": "IST" };
export function tzLabel(tz: string): string {
    if (TZ_LABELS[tz]) return TZ_LABELS[tz];
    try {
        const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(
            new Date(),
        );
        return parts.find((p) => p.type === "timeZoneName")?.value ?? tz;
    } catch {
        // An invalid zone should never reach here — the settings form validates it against
        // the same Intl constructor before saving — but falling back to the raw string beats
        // throwing out of a render.
        return tz;
    }
}

/**
 * "IST (Asia/Kolkata)" for the metadata card's footnote — or just "UTC" when the label and the
 * raw zone name are the same string, so that case does not read as "UTC (UTC)".
 */
export function tzDisplay(tz: string): string {
    const label = tzLabel(tz);
    return label === tz ? tz : `${label} (${tz})`;
}

/**
 * A managed service can end up on Spot while its account's automation is off — the enable/
 * capacity gate only stops a NEW action, it does nothing retroactive to a service already
 * enabled before the flag flipped. Once that happens, the hourly restore scan and the inbound
 * Spot-interruption handler both skip the account (see spot-guard-service.ts's own note on
 * SPOT_AUTOMATION_DISABLED), so this service rides out interruptions with nobody watching:
 * ECS retries placement against whatever capacity-provider strategy is already set, with no
 * automatic fallback to On-Demand and no automatic restore afterward. The skip itself is only
 * ever recorded as a routine timeline row (governance_skip, no Slack post), so without this
 * warning the only way to notice is to already be looking at that one service's event history.
 *
 * One shared string so the row badge and the detail-page banner say exactly the same thing.
 */
export const SPOT_UNSUPERVISED_LABEL = "Unsupervised on Spot";
export const SPOT_UNSUPERVISED_HINT =
    "Spot automation is disabled for this account, so Nucleus is not restoring this service or handling its interruptions while it runs on Spot capacity. Turn on Spot Automation for the account, or move this service to On-Demand.";

/**
 * "May 04, 2026" — the short form the audit line on each row uses.
 *
 * `tz` is required in spirit, not signature: it defaults to DEFAULT_DISPLAY_TZ only so a
 * caller mid-migration to the settings-driven value does not crash; every real call site
 * passes the tenant's reportTimezone explicitly.
 */
export function formatDate(iso: string | null | undefined, tz: string = DEFAULT_DISPLAY_TZ): string {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "2-digit", timeZone: tz });
}

/** Same contract as formatDate, with the time — for the metadata card. */
export function formatDateTime(iso: string | null | undefined, tz: string = DEFAULT_DISPLAY_TZ): string {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString("en-US", {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: tz,
    });
}

/** Render a capacityProviderStrategy compactly, e.g. "FARGATE_SPOT w100 b1 / FARGATE w0". */
/**
 * Current Spot share of a strategy, as a percentage of total weight.
 *
 * Used to seed the capacity dialog when changing an existing service: opening it on a service
 * already at 30% must show 30, not the new-service default. Weights are ratios, so this is
 * spot / (spot + on-demand) — which is why a 30/70 strategy reads back as exactly 30.
 * Returns null when there is no weight anywhere to divide by.
 */
export function spotPercentOf(strategy: CapacityProviderStrategyItem[] | null | undefined): number | null {
    if (!strategy || strategy.length === 0) return null;
    let spot = 0;
    let total = 0;
    for (const cp of strategy) {
        const w = cp.weight ?? 0;
        total += w;
        if (/spot/i.test(cp.capacityProvider)) spot += w;
    }
    if (total === 0) return 0; // all zero-weighted: nothing on Spot
    return Math.round((spot / total) * 100);
}

export function formatStrategy(strategy: CapacityProviderStrategyItem[] | null | undefined): string {
    if (!strategy || strategy.length === 0) return "—";
    return strategy
        .map((cp) => `${cp.capacityProvider} w${cp.weight ?? 0}${cp.base ? ` b${cp.base}` : ""}`)
        .join(" / ");
}

/**
 * Total weight on each side of a strategy.
 *
 * Summed rather than read positionally: a strategy may list more than one Spot or On-Demand
 * provider, and the order is not guaranteed.
 */
export function strategyWeights(strategy: CapacityProviderStrategyItem[] | null | undefined): {
    spot: number;
    onDemand: number;
} {
    let spot = 0;
    let onDemand = 0;
    for (const cp of strategy ?? []) {
        const w = cp.weight ?? 0;
        if (/spot/i.test(cp.capacityProvider)) spot += w;
        else onDemand += w;
    }
    return { spot, onDemand };
}

/**
 * Plain-language rendering of a capacity provider strategy.
 *
 * Replaces the raw "FARGATE_SPOT w1 / FARGATE w0" form, which required knowing that ECS weights
 * are relative ratios — w1/w0 and w100/w0 are the same thing, which the raw string actively hides.
 *
 * The badge is deliberately labelled by PERCENTAGE rather than "On spot" / "On-demand":
 *  - the Capacity column already carries an On Spot / On-Demand badge for the live capacityState,
 *    so repeating those words here would read as a duplicate of it, or — worse — as a
 *    contradiction, since observedStrategy is the last *observed* strategy and drifts from
 *    capacityState by design (that is what makes this the drift view);
 *  - a percentage is the only form that can express the blended splits that are now the default
 *    path. "On spot" cannot distinguish 30/70 from 100/0.
 *
 * The exact provider names and weights stay available on hover, so nothing is lost.
 */
export function StrategySummary({
    strategy,
    fromInventory,
}: {
    strategy: CapacityProviderStrategyItem[] | null | undefined;
    /** Borrowed from the discovery inventory rather than read live — surfaced as its own tag. */
    fromInventory?: boolean;
}) {
    const pct = spotPercentOf(strategy);
    const { spot, onDemand } = strategyWeights(strategy);
    const raw = formatStrategy(strategy);

    if (pct === null) {
        return <span className="text-xs text-muted-foreground">—</span>;
    }

    const label = pct === 100 ? "100% Spot" : pct === 0 ? "100% On-demand" : `${pct}% Spot`;
    // Same palette as CapacityBadge, so "all Spot" reads green and "all On-Demand" amber in both
    // columns. A split is sky, matching the 'mixed' capacity state it produces.
    const tone =
        pct === 100
            ? CAPACITY_CLASS.spot
            : pct === 0
              ? CAPACITY_CLASS.on_demand
              : CAPACITY_CLASS.mixed;

    return (
        <div className="space-y-1">
            <div className="flex items-center gap-1.5">
                <span
                    title={raw}
                    className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", tone)}
                >
                    {label}
                </span>
                {fromInventory && (
                    // Its own tag, not a suffix on the strategy text: it qualifies where the
                    // number came from, and reading "… / FARGATE w0 DISCOVERED" made it look
                    // like part of the AWS configuration.
                    <span
                        title="From the last discovery scan, not a live read — as stale as that scan. Spot Guard records its own value the first time it acts on this service."
                        // Lower case deliberately: set in caps it reads as a second status label
                        // competing with the badge, which is how the old "… FARGATE w0 DISCOVERED"
                        // suffix came across. This is a footnote about the number beside it.
                        className="inline-flex items-center rounded border px-1 py-0 text-[10px] text-muted-foreground"
                    >
                        discovered
                    </span>
                )}
            </div>
            <div className="font-mono text-[11px] text-muted-foreground" title={raw}>
                spot {spot} · on-demand {onDemand}
            </div>
        </div>
    );
}

const CAPACITY_LABEL: Record<CapacityState, string> = {
    spot: "On Spot",
    on_demand: "On-Demand",
    mixed: "Mixed",
    unknown: "Unknown",
};

const CAPACITY_CLASS: Record<CapacityState, string> = {
    spot: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
    // Amber, not red: falling back to On-Demand is Spot Guard working correctly — the
    // service is protected, just costing more. Red would train people to ignore it.
    on_demand: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
    mixed: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
    unknown: "bg-muted text-muted-foreground",
};

/**
 * @param desiredCount when exactly 0, the service is scaled down and reads "Stopped".
 *
 * capacityState is learned from task-state events — the capacity provider the most recent RUNNING
 * task launched on. A service scaled to zero produces no task events, so the value simply stops
 * moving: the badge goes on asserting "On Spot" for a service that has been running nothing for
 * hours. That is not hypothetical — non-prod is shut down nightly, so every managed service sits at
 * 0/0 all night while the column claimed each one was on some capacity.
 *
 * The last known state is kept in the tooltip rather than discarded, because "what was it on before
 * it stopped" is still the useful question.
 */
export function CapacityBadge({
    state,
    desiredCount,
    strategy,
    className,
}: {
    state: CapacityState;
    desiredCount?: number | null;
    /**
     * The configured strategy. Supplied so a deliberate blend reads "Mixed".
     *
     * capacityState cannot express a blend: the only writer in steady state is the task-event path,
     * and classifyCapacity() maps one task's provider to 'spot' or 'on_demand' — never 'mixed'. So a
     * 50/50 service showed whichever provider the most recent task to start happened to use, and
     * flipped between the two as tasks cycled. deriveCapacityState() does return 'mixed', but the
     * only caller is the placement-failure path, so a healthy blend never reached it.
     *
     * Deriving the blend here rather than changing the stored value on purpose: capacityState
     * answers "what did the last task actually run on", which is what makes fallback detection and
     * drift visible. This column answers "what is this service running on", and for a blend the
     * honest answer is both.
     */
    strategy?: CapacityProviderStrategyItem[] | null;
    className?: string;
}) {
    // Strict 0, not falsy: null/undefined means "never observed", which is not the same as stopped
    // and must keep showing the capacity state we do have.
    const stopped = desiredCount === 0;
    // Stopped wins over Mixed: if nothing is running, that is the more important fact. A service in
    // fallback is spot-zero-weighted, so it is not a split and correctly reads "On-Demand".
    const pct = spotPercentOf(strategy);
    const mixed = !stopped && pct !== null && pct > 0 && pct < 100;
    const label = stopped ? "Stopped" : mixed ? CAPACITY_LABEL.mixed : CAPACITY_LABEL[state];
    const tone = stopped ? "bg-muted text-muted-foreground" : mixed ? CAPACITY_CLASS.mixed : CAPACITY_CLASS[state];

    return (
        <span
            title={
                stopped
                    ? `Scaled to 0 tasks — no capacity in use. Last observed capacity: ${CAPACITY_LABEL[state]}.`
                    : mixed
                      ? // The per-task value is still worth surfacing: it is what the most recent task
                        // actually launched on, which a blend alone does not tell you.
                        `${pct}% Spot / ${100 - (pct ?? 0)}% On-Demand. Most recent task ran on ${CAPACITY_LABEL[state]}.`
                      : undefined
            }
            className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", tone, className)}
        >
            {label}
        </span>
    );
}

const MANAGEMENT_LABEL: Record<ManagementState, string> = {
    managed: "Managed",
    unmanaged: "Not automated",
    opted_out: "Opted out",
};

const MANAGEMENT_CLASS: Record<ManagementState, string> = {
    managed: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
    unmanaged: "bg-muted text-muted-foreground",
    opted_out: "bg-muted text-muted-foreground",
};

export function ManagementBadge({ state }: { state: ManagementState }) {
    return (
        <span
            className={cn(
                "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                MANAGEMENT_CLASS[state],
            )}
        >
            {MANAGEMENT_LABEL[state]}
        </span>
    );
}

export const ELIGIBILITY_LABEL: Record<SpotEligibility, string> = {
    spot_capable: "Spot capable",
    spot_addable: "Can add Spot",
    needs_capacity_providers: "Needs capacity providers",
};

/**
 * Why a service is or is not eligible. Shown as a tooltip so the UI explains rather than
 * presenting a disabled button with no reason.
 */
export const ELIGIBILITY_HINT: Record<SpotEligibility, string> = {
    spot_capable: "This service already has a Spot capacity provider — enabling only adjusts the weights.",
    spot_addable: "A Spot capacity provider will be added to this service's strategy.",
    needs_capacity_providers:
        "This service uses a plain launch type with no capacity provider strategy, or its cluster has no Spot provider registered. Register FARGATE_SPOT on the cluster and migrate the service off launchType first — Nucleus cannot do that through UpdateService.",
};

const ELIGIBILITY_CLASS: Record<SpotEligibility, string> = {
    spot_capable: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
    spot_addable: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
    needs_capacity_providers: "bg-muted text-muted-foreground",
};

export function EligibilityBadge({ eligibility }: { eligibility: SpotEligibility }) {
    return (
        <span
            title={ELIGIBILITY_HINT[eligibility]}
            className={cn(
                "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                ELIGIBILITY_CLASS[eligibility],
            )}
        >
            {ELIGIBILITY_LABEL[eligibility]}
        </span>
    );
}

export const EVENT_TYPE_LABEL: Record<SpotEventType, string> = {
    interruption: "Spot interruption",
    placement_failure: "Placement failure",
    fallback_applied: "Fell back to On-Demand",
    restore_attempted: "Restore attempted",
    restore_succeeded: "Restored to Spot",
    restore_failed: "Restore failed",
    spot_enabled: "Spot enabled",
    spot_disabled: "Spot disabled",
    unmanaged: "Management changed",
    capacity_transition: "Capacity changed",
    alb_predrain: "Traffic drained",
    governance_skip: "Skipped (governance)",
    backoff_skip: "Skipped (backoff)",
};

const SEVERITY_CLASS: Record<SpotEventSeverity, string> = {
    info: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
    warning: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
    critical: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
};

export function SeverityBadge({ severity }: { severity: SpotEventSeverity }) {
    return (
        <span
            className={cn(
                "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize",
                SEVERITY_CLASS[severity],
            )}
        >
            {severity}
        </span>
    );
}
