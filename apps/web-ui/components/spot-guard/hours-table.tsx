"use client";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { Clock } from "lucide-react";
import { formatHours, formatPercent } from "./shared";
import type { HoursReportRow } from "@/lib/db/repositories/spot-guard/interface";

/**
 * Spot vs On-Demand hours, one row per service.
 *
 * The /api/spot-guard/report endpoint returns the whole window in one payload — it aggregates task
 * sessions rather than paging rows — so the caller slices `rows` and this renders whatever page it
 * is handed. `orphaned` and `inFlightSessions` describe the FULL report, not the current page,
 * which is why they are passed separately instead of being derived from `rows`.
 */
export function HoursTable({
    rows,
    loading,
    orphaned = 0,
    inFlightSessions = 0,
}: {
    rows: HoursReportRow[];
    loading: boolean;
    orphaned?: number;
    inFlightSessions?: number;
}) {
    if (loading) {
        return <Skeleton className="h-40 w-full" />;
    }

    if (rows.length === 0) {
        return (
            <EmptyState
                icon={Clock}
                title="No task sessions recorded yet"
                description="Hours accumulate as Nucleus observes ECS tasks starting and stopping."
            />
        );
    }

    return (
        <>
            <div className="rounded-md border">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Service</TableHead>
                            <TableHead className="text-right">Spot</TableHead>
                            <TableHead className="text-right">On-Demand</TableHead>
                            <TableHead className="text-right">Spot share</TableHead>
                            <TableHead className="text-right">Interruptions</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {rows.map((r) => (
                            <TableRow key={`${r.accountId}/${r.region}/${r.clusterName}/${r.serviceName}`}>
                                <TableCell>
                                    <div className="text-sm font-medium">{r.serviceName}</div>
                                    <div className="text-xs text-muted-foreground">
                                        {r.clusterName} · {r.region}
                                    </div>
                                </TableCell>
                                <TableCell className="text-right text-sm">{formatHours(r.spotHours)}</TableCell>
                                <TableCell className="text-right text-sm">{formatHours(r.onDemandHours)}</TableCell>
                                <TableCell className="text-right text-sm">{formatPercent(r.spotShare)}</TableCell>
                                <TableCell className="text-right text-sm">{r.interruptions}</TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </div>

            {/* Surface incomplete data rather than letting it silently deflate the totals — an
                orphaned session is hours we cannot account for. */}
            {orphaned > 0 && (
                <p className="mt-2 text-xs text-amber-600">
                    {orphaned} task session(s) never recorded a stop and are excluded, so these figures may
                    understate real usage.
                </p>
            )}
            {inFlightSessions > 0 && (
                <p className="mt-1 text-xs text-muted-foreground">
                    {inFlightSessions} task(s) still running, counted up to now.
                </p>
            )}
        </>
    );
}
