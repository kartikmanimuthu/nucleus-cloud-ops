"use client";

import { EmptyState } from "@/components/shared/empty-state";
import { ArrowRight, Clock } from "lucide-react";
// Reuse the shared label map and badge rather than forking them: shared.tsx already keys
// EVENT_TYPE_LABEL off the SpotEventType union, so a taxonomy change fails in one place.
import { EVENT_TYPE_LABEL, SeverityBadge, formatRelative, formatStrategy } from "./shared";
import type { CapacityType, SpotGuardEvent } from "@/lib/db/repositories/spot-guard/interface";

const CAPACITY_LABEL: Record<CapacityType, string> = { spot: "Spot", on_demand: "On-Demand" };

/**
 * Chronological event feed for one service.
 *
 * The capacity transition is rendered explicitly (Spot → On-Demand) rather than left buried in the
 * message text, because "when did this service move onto/off Spot, and why" is the question this
 * view exists to answer.
 */
export function EventTimeline({
    events,
    loading,
    emptyKind = "all",
}: {
    events: SpotGuardEvent[];
    loading: boolean;
    /**
     * Only changes the empty-state wording. This component does NOT filter — callers narrow by
     * eventTypes in the query so the paginated total matches what is shown. A second, client-side
     * filter here would hide rows the pagination had already counted.
     *
     * "all" describes ONE service; "interruptions" is the tenant-wide feed behind the
     * Interruptions tab, so its wording must not say "this service".
     */
    emptyKind?: "all" | "interruptions";
}) {
    if (loading) {
        return <p className="text-sm text-muted-foreground">Loading events…</p>;
    }

    if (events.length === 0) {
        const empty = {
            interruptions: {
                title: "No interruptions in the last 24 hours",
                description: "AWS has not reclaimed a Spot task from any managed service in that window.",
            },
            all: {
                title: "No events yet",
                description:
                    "Events appear as Nucleus observes interruptions, fallbacks and restores for this service.",
            },
        }[emptyKind];

        return <EmptyState icon={Clock} title={empty.title} description={empty.description} />;
    }

    return (
        <ol className="space-y-3">
            {events.map((e) => (
                <li key={e.id} className="flex gap-3 rounded-md border p-3">
                    <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium">{EVENT_TYPE_LABEL[e.eventType] ?? e.eventType}</span>
                            <SeverityBadge severity={e.severity} />
                            {/* The transition itself, stated plainly. */}
                            {(e.fromCapacity || e.toCapacity) && (
                                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                                    {e.fromCapacity ? CAPACITY_LABEL[e.fromCapacity] : "unknown"}
                                    <ArrowRight className="h-3 w-3" />
                                    <span className="font-medium text-foreground">
                                        {e.toCapacity ? CAPACITY_LABEL[e.toCapacity] : "unknown"}
                                    </span>
                                </span>
                            )}
                        </div>

                        <p className="mt-1 text-sm text-muted-foreground">{e.message}</p>

                        {(e.strategyBefore?.length || e.strategyAfter?.length) && (
                            <p className="mt-1 font-mono text-xs text-muted-foreground">
                                {formatStrategy(e.strategyBefore)} → {formatStrategy(e.strategyAfter)}
                            </p>
                        )}

                        <div className="mt-1 flex flex-wrap gap-3 text-xs text-muted-foreground">
                            <span title={e.occurredAt}>{formatRelative(e.occurredAt)}</span>
                            <span>by {e.actor}</span>
                            {/* Say when Slack was suppressed. A missing alert during an incident is
                                otherwise indistinguishable from an alert that was never generated. */}
                            {!e.notifiedSlack && <span title="Suppressed by the alert dedup window">no Slack alert</span>}
                            {e.stoppedReason && <span title={e.stoppedReason}>reason: {e.stopCode ?? "see tooltip"}</span>}
                        </div>
                    </div>
                </li>
            ))}
        </ol>
    );
}
