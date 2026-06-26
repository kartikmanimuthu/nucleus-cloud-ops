"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { TrendingDown, AlertTriangle, Moon, CheckCircle2 } from "lucide-react";
import { formatMoney } from "./shared";
import type { RightSizingSummary } from "@/lib/db/repositories/right-sizing/interface";

export function SummaryCards({ summary, loading }: { summary: RightSizingSummary | null; loading: boolean }) {
    if (loading) {
        return (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-28 w-full" />
                ))}
            </div>
        );
    }

    const f = summary?.byFinding ?? {};
    const cards = [
        {
            title: "Potential Monthly Savings",
            value: formatMoney(summary?.totalPotentialMonthlySavings ?? 0),
            icon: TrendingDown,
            accent: "text-emerald-600",
        },
        {
            title: "Over-provisioned",
            value: String((f.over_provisioned ?? 0)),
            icon: AlertTriangle,
            accent: "text-amber-600",
        },
        { title: "Idle", value: String(f.idle ?? 0), icon: Moon, accent: "text-purple-600" },
        {
            title: "Under-provisioned",
            value: String(f.under_provisioned ?? 0),
            icon: AlertTriangle,
            accent: "text-red-600",
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
                        </CardContent>
                    </Card>
                ))}
            </div>
            {summary?.lastRunAt && (
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                    <CheckCircle2 className="h-3 w-3" /> Last scanned {new Date(summary.lastRunAt).toLocaleString()}
                </p>
            )}
        </div>
    );
}
