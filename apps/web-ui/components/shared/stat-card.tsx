import type { LucideIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type StatTone = "ok" | "warn" | "err";

const toneBadge: Record<StatTone, { className?: string; variant?: "destructive" }> = {
    ok: { className: "bg-success text-success-foreground hover:bg-success/90" },
    warn: { className: "bg-warning text-warning-foreground hover:bg-warning/90" },
    err: { variant: "destructive" },
};

interface StatCardProps {
    /** Small label shown in the card header (e.g. "Total Events"). */
    label: string;
    /** The headline metric (e.g. a count). */
    value: React.ReactNode;
    /** Optional muted sub-text under the value. */
    sub?: string;
    /** Optional icon shown top-right (used when no badge is given). */
    icon?: LucideIcon;
    /** Optional status badge shown top-right (takes precedence over icon). */
    badge?: { label: string; tone: StatTone };
    className?: string;
}

/**
 * Metric card used in dashboard / audit stat rows: label + big number +
 * optional sub-text, with an optional top-right icon or status badge.
 */
export function StatCard({ label, value, sub, icon: Icon, badge, className }: StatCardProps) {
    const badgeProps = badge ? toneBadge[badge.tone] : null;
    return (
        <Card className={className}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{label}</CardTitle>
                {badge && badgeProps ? (
                    <Badge variant={badgeProps.variant} className={cn(badgeProps.className)}>
                        {badge.label}
                    </Badge>
                ) : Icon ? (
                    <Icon className="size-4 text-muted-foreground" />
                ) : null}
            </CardHeader>
            <CardContent>
                <div className="text-2xl font-bold">{value}</div>
                {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
            </CardContent>
        </Card>
    );
}
