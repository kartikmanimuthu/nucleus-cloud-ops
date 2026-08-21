"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Activity, AlertTriangle, Boxes, CheckCircle2 } from "lucide-react";
import type { ScalingAuditSummary } from "@/lib/db/repositories/scaling-audit/interface";
import { formatIstDateTime } from "./shared";

export function SummaryCards({ summary, loading }: { summary: ScalingAuditSummary | null; loading: boolean }) {
    if (loading) {
        return (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-28 w-full" />
                ))}
            </div>
        );
    }

    const bySource = summary?.bySource ?? {};
    const byScope = summary?.byScope ?? {};
    const cards = [
        {
            // "Evidence records", not "scaling events". One physical capacity
            // change can legitimately produce more than one row: a manual ASG
            // change is observed independently by the activity API and by
            // CloudTrail, and the two are deliberately not merged (no exact join
            // key — a wrong merge would attribute a change to the wrong
            // principal). Labelling this "events" would overstate how much
            // scaling occurred.
            title: "Evidence Records",
            value: String(summary?.totalEvents ?? 0),
            hint: "Rows captured. A single change may be observed by more than one source.",
            icon: Activity,
            accent: "text-blue-600",
        },
        {
            title: "ASG / ECS",
            value: `${byScope.asg ?? 0} / ${byScope.ecs ?? 0}`,
            icon: Boxes,
            accent: "text-purple-600",
        },
        {
            title: "Out-of-band (CloudTrail)",
            value: String(bySource.cloudtrail ?? 0),
            hint: "Direct API changes made outside any scaling policy, with the principal.",
            icon: CheckCircle2,
            accent: "text-amber-600",
        },
        {
            title: "Open Coverage Gaps",
            value: String(summary?.openGaps ?? 0),
            icon: AlertTriangle,
            accent: (summary?.openGaps ?? 0) > 0 ? "text-red-600" : "text-muted-foreground",
        },
    ];

    return (
        <div className="space-y-2">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {cards.map((c) => (
                    <Card key={c.title}>
                        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                            <CardTitle className="text-sm font-medium text-muted-foreground">{c.title}</CardTitle>
                            <c.icon className={`h-4 w-4 ${c.accent}`} />
                        </CardHeader>
                        <CardContent>
                            <div className="text-2xl font-bold">{c.value}</div>
                            {c.hint && <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{c.hint}</p>}
                        </CardContent>
                    </Card>
                ))}
            </div>
            {summary?.lastRunAt && (
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                    <CheckCircle2 className="h-3 w-3" /> Last scan {summary.lastRunStatus ?? "unknown"} at{" "}
                    {formatIstDateTime(summary.lastRunAt)} IST
                </p>
            )}
        </div>
    );
}
