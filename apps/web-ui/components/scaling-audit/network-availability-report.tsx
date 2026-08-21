"use client";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import type { NetworkAvailabilityReportRow } from "@/lib/db/repositories/network-links/interface";

/**
 * Direct Connect & VPN compliance report — a fixed set of availability/
 * bandwidth summary rows for the selected window, not a resource-browsing
 * list. Purely presentational: the page fetches rows via
 * useNetworkAvailabilityReport and passes them down.
 */
export function NetworkAvailabilityReport({
    rows,
    loading,
}: {
    rows: NetworkAvailabilityReportRow[];
    loading: boolean;
}) {
    if (loading) return <Skeleton className="h-72 w-full" />;

    if (rows.length === 0) {
        return (
            <div className="rounded-md border p-10 text-center text-sm text-muted-foreground">
                No network link samples match the current filters.
            </div>
        );
    }

    return (
        <div className="overflow-x-auto rounded-md border">
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>Particulars</TableHead>
                        <TableHead>Installed Capacity</TableHead>
                        <TableHead>Utilised capacity</TableHead>
                        <TableHead>Highest Peak load during period</TableHead>
                        <TableHead className="text-right">No. of instances &gt;70%</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {rows.map((row, i) => (
                        <TableRow key={`${row.particulars}-${i}`}>
                            <TableCell className="font-medium">{row.particulars}</TableCell>
                            <TableCell>{row.installedCapacity}</TableCell>
                            <TableCell>{row.utilisedCapacity}</TableCell>
                            <TableCell>{row.peakLoad}</TableCell>
                            <TableCell className="text-right">
                                {row.breachCount === null ? "N/A" : row.breachCount}
                            </TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </div>
    );
}
