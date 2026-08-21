"use client";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { AccountRegion } from "@/components/shared/account-region";
import type { ScalingResourceSummary } from "@/lib/db/repositories/scaling-audit/interface";
import { formatIstDate, formatIstDateTime, SCOPE_LABELS } from "./shared";

/**
 * Resource-centric list — the default Scale Sentinel view, mirroring Spot Guard.
 *
 * A flat event log buries everything under whichever resource happens to be
 * busiest: one service with a target-tracking policy can produce hundreds of rows
 * while a genuinely interesting one-off change on another sits pages away. Rolling
 * up by resource puts "which things scaled, and how much" first, and keeps the
 * chronological record one click away.
 */
export function ScalingResourcesTable({
    resources,
    loading,
    onSelect,
    accountNameById,
}: {
    resources: ScalingResourceSummary[];
    loading: boolean;
    onSelect: (resource: ScalingResourceSummary) => void;
    accountNameById?: Map<string, string>;
}) {
    if (loading) return <Skeleton className="h-72 w-full" />;

    if (resources.length === 0) {
        return (
            <div className="rounded-md border p-10 text-center text-sm text-muted-foreground">
                No resources match the current filters.
            </div>
        );
    }

    return (
        <div className="overflow-x-auto rounded-md border">
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>Resource</TableHead>
                        <TableHead>Account / Region</TableHead>
                        <TableHead className="text-right">Scaling events</TableHead>
                        <TableHead>First seen (IST)</TableHead>
                        <TableHead>Last event (IST)</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {resources.map((r) => (
                        <TableRow
                            key={`${r.scope}:${r.resourceId}:${r.accountId}:${r.region}`}
                            className="cursor-pointer"
                            onClick={() => onSelect(r)}
                        >
                            <TableCell>
                                <div className="font-medium">{r.displayName}</div>
                                <div className="text-xs text-muted-foreground">
                                    {SCOPE_LABELS[r.scope] ?? r.scope}
                                    {/* Cluster disambiguates two services sharing a name. */}
                                    {r.scope === "ecs" && r.clusterName ? ` · ${r.clusterName}` : ""}
                                </div>
                            </TableCell>
                            <TableCell>
                                <AccountRegion
                                    accountId={r.accountId}
                                    accountName={accountNameById?.get(r.accountId)}
                                    region={r.region}
                                />
                            </TableCell>
                            <TableCell className="text-right">
                                <Badge variant="secondary">{r.eventCount}</Badge>
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                                {formatIstDate(r.firstEventAt)}
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-sm">
                                {formatIstDateTime(r.lastEventAt)}
                            </TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </div>
    );
}
