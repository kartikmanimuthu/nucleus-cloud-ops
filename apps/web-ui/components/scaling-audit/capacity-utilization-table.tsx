"use client";

import { useState } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronRight } from "lucide-react";
import { AccountRegion } from "@/components/shared/account-region";
import { formatIstDateTime } from "./shared";
import { useCapacityBreachInstances } from "@/lib/queries/capacity-planning";
import type { CapacityUtilizationSummaryRow } from "@/lib/db/repositories/capacity-planning/interface";

function pct(v?: number | null): string {
    return v == null ? "—" : `${v.toFixed(1)}%`;
}

function resourceTypeLabel(t: CapacityUtilizationSummaryRow["resourceType"]): string {
    return t === "asg" ? "Auto Scaling Group" : "ECS Service";
}

function installed(row: CapacityUtilizationSummaryRow): string {
    if (row.installedVcpu == null && row.installedMemGiB == null) return "—";
    const cpu = row.installedVcpu != null ? `${row.installedVcpu} vCPU` : "?";
    const mem = row.installedMemGiB != null ? `${row.installedMemGiB.toFixed(2)} GB RAM` : "?";
    return `${cpu}, ${mem}`;
}

function utilisation(row: CapacityUtilizationSummaryRow, which: "avg" | "max"): string {
    const cpu = which === "avg" ? row.cpuAvg : row.cpuMax;
    const mem = which === "avg" ? row.memAvg : row.memMax;
    return `CPU ${pct(cpu)} / Mem ${pct(mem)}`;
}

/** Breach instances for one resource, fetched only once its row is expanded —
 *  a tenant-wide breach list can run into the thousands, so nothing loads it
 *  until someone actually asks for that resource's detail. */
function BreachDetail({ resourceId, accountId }: { resourceId: string; accountId: string }) {
    const query = useCapacityBreachInstances({ page: 1, limit: 50, search: resourceId, accountId });

    if (query.isLoading) return <Skeleton className="m-3 h-16" />;
    const breaches = query.data?.data ?? [];
    if (!breaches.length) return <p className="p-3 text-sm text-muted-foreground">No breach instances on record.</p>;

    return (
        <div className="max-h-64 overflow-y-auto border-t">
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>Metric</TableHead>
                        <TableHead>Utilisation</TableHead>
                        <TableHead>Bucket (IST)</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {breaches.map((b, i) => (
                        <TableRow key={`${b.bucketStartUtc}-${b.metric}-${i}`}>
                            <TableCell className="uppercase text-xs">{b.metric}</TableCell>
                            <TableCell>{pct(b.utilizationPercent)}</TableCell>
                            <TableCell className="text-xs text-muted-foreground">{formatIstDateTime(b.bucketStartUtc)}</TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
            {(query.data?.total ?? 0) > breaches.length && (
                <p className="p-2 text-center text-xs text-muted-foreground">
                    Showing the {breaches.length} most recent of {query.data?.total} — narrow the date range to see more.
                </p>
            )}
        </div>
    );
}

/** Expandable in place with a plain conditional second row — Radix's
 *  Collapsible renders a div, which isn't valid inside <tbody>, so this skips
 *  it rather than fighting table semantics for an animation that doesn't add
 *  much here. */
function ResourceRow({ row, accountName }: { row: CapacityUtilizationSummaryRow; accountName?: string }) {
    const [expanded, setExpanded] = useState(false);

    return (
        <>
            <TableRow className="cursor-pointer" onClick={() => setExpanded((v) => !v)}>
                <TableCell>
                    <div className="flex items-center gap-1">
                        <ChevronRight className={`h-4 w-4 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`} />
                        <div>
                            <div className="font-medium">{row.displayName}</div>
                            <div className="text-xs text-muted-foreground">
                                {resourceTypeLabel(row.resourceType)}
                                {row.resourceType === "ecs" && row.clusterName ? ` · ${row.clusterName}` : ""}
                            </div>
                        </div>
                    </div>
                </TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                    <AccountRegion accountId={row.accountId} accountName={accountName} region={row.region} />
                </TableCell>
                <TableCell className="text-xs">{installed(row)}</TableCell>
                <TableCell className="text-xs">{utilisation(row, "avg")}</TableCell>
                <TableCell className="text-xs">{utilisation(row, "max")}</TableCell>
                <TableCell className="text-right">
                    {row.breachCount > 0 ? (
                        <Badge variant="destructive">{row.breachCount}</Badge>
                    ) : (
                        <Badge variant="secondary">0</Badge>
                    )}
                </TableCell>
            </TableRow>
            {expanded && (
                <TableRow>
                    <TableCell colSpan={6} className="p-0">
                        <BreachDetail resourceId={row.resourceId} accountId={row.accountId} />
                    </TableCell>
                </TableRow>
            )}
        </>
    );
}

export function CapacityUtilizationTable({
    resources,
    loading,
    accountNameById,
}: {
    resources: CapacityUtilizationSummaryRow[];
    loading: boolean;
    accountNameById?: Map<string, string>;
}) {
    if (loading) return <Skeleton className="h-72 w-full" />;

    if (resources.length === 0) {
        return (
            <div className="rounded-md border p-10 text-center text-sm text-muted-foreground">
                No capacity data yet — it appears after the first Capacity Planning scan runs.
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
                        <TableHead>Installed capacity</TableHead>
                        <TableHead>Utilised (avg)</TableHead>
                        <TableHead>Peak</TableHead>
                        <TableHead className="text-right">Breach instances</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {resources.map((r) => (
                        <ResourceRow key={`${r.resourceType}:${r.resourceId}:${r.accountId}:${r.region}`} row={r} accountName={accountNameById?.get(r.accountId)} />
                    ))}
                </TableBody>
            </Table>
        </div>
    );
}
