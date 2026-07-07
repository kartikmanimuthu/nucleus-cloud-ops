"use client";

import { useRouter } from "next/navigation";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowRight } from "lucide-react";
import { formatMoney, FindingBadge, RiskBadge, StatusBadge, RESOURCE_TYPE_LABELS } from "./shared";
import type { RightSizingRecommendation } from "@/lib/db/repositories/right-sizing/interface";

function configLabel(config: Record<string, unknown> | null | undefined): string {
    if (!config) return "—";
    return (
        (config.instanceType as string) ||
        (config.dbInstanceClass as string) ||
        (config.volumeType as string) ||
        (config.action as string) ||
        "—"
    );
}

export function RecommendationsTable({
    recommendations,
    loading,
    getHref,
}: {
    recommendations: RightSizingRecommendation[];
    loading: boolean;
    getHref: (r: RightSizingRecommendation) => string;
}) {
    const router = useRouter();

    if (loading) {
        return <Skeleton className="h-72 w-full" />;
    }
    if (recommendations.length === 0) {
        return (
            <div className="rounded-md border p-10 text-center text-sm text-muted-foreground">
                No recommendations match the current filters. Run a scan to generate recommendations.
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
                        <TableHead>Finding</TableHead>
                        <TableHead>Change</TableHead>
                        <TableHead className="text-right">Savings / mo</TableHead>
                        <TableHead className="text-right">Confidence</TableHead>
                        <TableHead>Risk</TableHead>
                        <TableHead>Status</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {recommendations.map((r) => (
                        <TableRow key={r.id} className="cursor-pointer" onClick={() => router.push(getHref(r))}>
                            <TableCell>
                                <div className="font-medium">{r.name || r.resourceId}</div>
                                <div className="text-xs text-muted-foreground">
                                    {RESOURCE_TYPE_LABELS[r.resourceType] ?? r.resourceType}
                                </div>
                            </TableCell>
                            <TableCell className="text-sm">
                                <div>{r.accountId}</div>
                                <div className="text-xs text-muted-foreground">{r.region}</div>
                            </TableCell>
                            <TableCell>
                                <FindingBadge finding={r.finding} />
                            </TableCell>
                            <TableCell>
                                <div className="flex items-center gap-1 text-sm">
                                    <span>{configLabel(r.currentConfig as Record<string, unknown>)}</span>
                                    {r.recommendedConfig && (
                                        <>
                                            <ArrowRight className="h-3 w-3 text-muted-foreground" />
                                            <span className="font-medium">
                                                {configLabel(r.recommendedConfig as Record<string, unknown>)}
                                            </span>
                                        </>
                                    )}
                                </div>
                            </TableCell>
                            <TableCell className="text-right font-medium text-emerald-600">
                                {formatMoney(r.estimatedMonthlySavings)}
                            </TableCell>
                            <TableCell className="text-right">{Math.round(r.confidence * 100)}%</TableCell>
                            <TableCell>
                                <RiskBadge risk={r.riskLevel} />
                            </TableCell>
                            <TableCell>
                                <StatusBadge status={r.status} />
                            </TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </div>
    );
}
