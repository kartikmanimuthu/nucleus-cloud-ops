"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Zap, AlertTriangle, Clock, PiggyBank } from "lucide-react";
import { formatHours, formatPercent } from "./shared";
import type { SpotGuardSummary } from "@/lib/db/repositories/spot-guard/interface";

/** Which KPI was clicked. The page decides what to do with it. */
export type SummaryCardAction = "on_spot" | "in_fallback" | "interruptions" | "hours";

export function SummaryCards({
    summary,
    loading,
    onSelect,
}: {
    summary: SpotGuardSummary | null;
    loading: boolean;
    /**
     * Called when a card is activated. Every card resolves the same way — it reveals its detail
     * in a tab on the page below, paginated like the rest. The two service-count cards narrow the
     * Managed table; interruptions and hours each open their own tab, because that data has no
     * representation in the services table.
     */
    onSelect?: (action: SummaryCardAction) => void;
}) {
    if (loading) {
        return (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-28 w-full" />
                ))}
            </div>
        );
    }

    const managed = summary?.managedServices ?? 0;
    const onSpot = summary?.servicesOnSpot ?? 0;
    const inFallback = summary?.servicesInFallback ?? 0;

    const cards = [
        {
            action: "on_spot" as const,
            title: "Services on Spot",
            // The ratio matters more than the count — "3" means nothing without the total.
            value: managed > 0 ? `${onSpot} / ${managed}` : "—",
            hint: managed > 0 ? `${formatPercent(onSpot / managed)} of managed services` : "No managed services yet",
            icon: Zap,
            accent: "text-emerald-600",
        },
        {
            action: "in_fallback" as const,
            title: "In Fallback",
            value: String(inFallback),
            // Amber, never red: fallback is Spot Guard doing its job. The service is up and
            // protected; it is just costing more until capacity returns.
            //
            // managed === 0 gets its own line, matching the "Services on Spot" card's identical
            // guard just above: "All managed services on Spot" is vacuously true with nothing
            // managed, and on a brand new tenant reads as if something IS already running.
            hint:
                managed === 0
                    ? "No managed services yet"
                    : inFallback > 0
                      ? "Running On-Demand until Spot capacity returns"
                      : "All managed services on Spot",
            icon: AlertTriangle,
            accent: inFallback > 0 ? "text-amber-600" : "text-muted-foreground",
        },
        {
            action: "interruptions" as const,
            title: "Interruptions (24h)",
            value: String(summary?.interruptions24h ?? 0),
            hint: `${summary?.placementFailures24h ?? 0} placement failure(s)`,
            icon: Clock,
            accent: "text-sky-600",
        },
        {
            action: "hours" as const,
            title: "Spot Hours (7d)",
            value: formatHours(summary?.spotHours7d ?? 0),
            hint: `${formatPercent(summary?.spotShare7d ?? 0)} on Spot · ${formatHours(summary?.onDemandHours7d ?? 0)} On-Demand`,
            icon: PiggyBank,
            accent: "text-emerald-600",
        },
    ];

    return (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {cards.map((card) => (
                <Card
                    key={card.title}
                    role={onSelect ? "button" : undefined}
                    tabIndex={onSelect ? 0 : undefined}
                    aria-label={onSelect ? `${card.title}: show breakdown` : undefined}
                    onClick={onSelect ? () => onSelect(card.action) : undefined}
                    // Keyboard parity: a div given role=button is not focusable or activatable on
                    // its own, and these are real navigation affordances.
                    onKeyDown={
                        onSelect
                            ? (e) => {
                                  if (e.key === "Enter" || e.key === " ") {
                                      e.preventDefault();
                                      onSelect(card.action);
                                  }
                              }
                            : undefined
                    }
                    className={onSelect ? "cursor-pointer transition-colors hover:bg-muted/50" : undefined}
                >
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium text-muted-foreground">{card.title}</CardTitle>
                        <card.icon className={`h-4 w-4 ${card.accent}`} />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-semibold">{card.value}</div>
                        <p className="mt-1 text-xs text-muted-foreground">{card.hint}</p>
                    </CardContent>
                </Card>
            ))}
        </div>
    );
}
