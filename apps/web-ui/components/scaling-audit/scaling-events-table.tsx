"use client";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import type { ScalingEvent } from "@/lib/db/repositories/scaling-audit/interface";
import { AccountRegion } from "@/components/shared/account-region";
import { capacityChangeHint, formatCapacityChange, formatIstDateTime, scalingTypeLabel, SCOPE_LABELS, SOURCE_LABELS } from "./shared";

function resourceLabel(e: ScalingEvent): string {
    if (e.scope === "asg") return e.asgName ?? e.resourceId;
    return e.serviceName ? `${e.serviceName} (${e.clusterName ?? "?"})` : e.resourceId;
}

export function ScalingEventsTable({
    events,
    loading,
    onSelect,
    accountNameById,
}: {
    events: ScalingEvent[];
    loading: boolean;
    onSelect: (event: ScalingEvent) => void;
    /** accountId -> friendly name. Absent entries fall back to the number alone. */
    accountNameById?: Map<string, string>;
}) {
    if (loading) {
        return <Skeleton className="h-72 w-full" />;
    }
    if (events.length === 0) {
        return (
            <div className="rounded-md border p-10 text-center text-sm text-muted-foreground">
                No scaling events match the current filters.
            </div>
        );
    }

    return (
        <div className="overflow-x-auto rounded-md border">
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>Started (IST)</TableHead>
                        <TableHead>Resource</TableHead>
                        <TableHead>Account / Region</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Source</TableHead>
                        <TableHead>Capacity</TableHead>
                        <TableHead>Status</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {events.map((e) => (
                        <TableRow key={e.id} className="cursor-pointer" onClick={() => onSelect(e)}>
                            <TableCell className="whitespace-nowrap text-sm">
                                {formatIstDateTime(e.startedAt)}
                            </TableCell>
                            <TableCell>
                                <div className="font-medium">{resourceLabel(e)}</div>
                                <div className="text-xs text-muted-foreground">{SCOPE_LABELS[e.scope] ?? e.scope}</div>
                            </TableCell>
                            <TableCell>
                                <AccountRegion
                                    accountId={e.accountId}
                                    accountName={accountNameById?.get(e.accountId)}
                                    region={e.region}
                                />
                            </TableCell>
                            <TableCell>
                                <Badge variant={e.scalingType === "not_scaled" || e.scalingType === "unparsed" ? "destructive" : "secondary"}>
                                    {scalingTypeLabel(e.scalingType)}
                                </Badge>
                            </TableCell>
                            <TableCell className="text-sm">{SOURCE_LABELS[e.source] ?? e.source}</TableCell>
                            <TableCell className="text-sm" title={capacityChangeHint(e.desiredBefore, e.desiredAfter, e.desiredBeforeSource)}>
                                {formatCapacityChange(e.desiredBefore, e.desiredAfter)}
                            </TableCell>
                            <TableCell className="text-sm">{e.statusCode ?? "—"}</TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </div>
    );
}
