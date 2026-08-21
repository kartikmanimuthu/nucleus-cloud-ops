"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { GatedButton } from "@/components/rbac/gated";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, ChevronLeft, ChevronRight, Check, X, Clock, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { formatMoney, FindingBadge, RiskBadge, StatusBadge, RESOURCE_TYPE_LABELS } from "./shared";
import { ResourceContextPanel } from "./resource-context-panel";
import { MetricCharts } from "./metric-charts";
import { buildReasoningLines } from "@/lib/right-sizing/reasoning";
import {
    useRightSizingRecommendation,
    useRightSizingRecommendations,
    useUpdateRightSizingRecommendation,
    type RightSizingFilters,
} from "@/lib/queries/right-sizing";
import type { RecommendationStatus } from "@/lib/db/repositories/right-sizing/interface";
import type { MetricsSummary } from "@/lib/right-sizing/types";

const PREV_NEXT_LIMIT = 1000;

function filtersFromSearchParams(sp: URLSearchParams): Omit<RightSizingFilters, "page" | "limit"> {
    return {
        sort: sp.get("sort") || "savings",
        search: sp.get("search") || undefined,
        resourceType: sp.get("resourceType") || undefined,
        finding: sp.get("finding") || undefined,
        status: sp.get("status") || undefined,
    };
}

export function RecommendationDetailPage({ recommendationId }: { recommendationId: string }) {
    const router = useRouter();
    const searchParams = useSearchParams();
    const [snoozeDate, setSnoozeDate] = useState("");
    const [busy, setBusy] = useState<RecommendationStatus | null>(null);

    const queryString = searchParams.toString();
    const filters = filtersFromSearchParams(searchParams);

    const detailQuery = useRightSizingRecommendation(recommendationId);
    const listQuery = useRightSizingRecommendations({ ...filters, page: 1, limit: PREV_NEXT_LIMIT });
    const updateMutation = useUpdateRightSizingRecommendation();

    const backHref = `/app/right-sizing${queryString ? `?${queryString}` : ""}`;

    if (detailQuery.isLoading) {
        return (
            <div className="space-y-4 p-6">
                <Skeleton className="h-8 w-48" />
                <Skeleton className="h-40 w-full" />
                <Skeleton className="h-64 w-full" />
            </div>
        );
    }

    if (!detailQuery.data) {
        return (
            <div className="space-y-4 p-6">
                <Button variant="outline" size="sm" onClick={() => router.push(backHref)}>
                    <ArrowLeft className="h-4 w-4" />
                    <span className="ml-1">Back to Right Sizing</span>
                </Button>
                <div className="rounded-md border p-10 text-center text-sm text-muted-foreground">
                    {detailQuery.error instanceof Error ? detailQuery.error.message : "Recommendation not found."}
                </div>
            </div>
        );
    }

    const { recommendation: r, resource, account } = detailQuery.data;
    const pricingUnavailable = r.currentMonthlyCost == null;
    const reasoningLines = buildReasoningLines(r.resourceType, r.metricsSummary as unknown as MetricsSummary);

    const orderedIds = listQuery.data?.data.map((item) => item.id) ?? [];
    const currentIndex = orderedIds.indexOf(recommendationId);
    const prevId = currentIndex > 0 ? orderedIds[currentIndex - 1] : null;
    const nextId = currentIndex >= 0 && currentIndex < orderedIds.length - 1 ? orderedIds[currentIndex + 1] : null;
    const positionLabel =
        currentIndex >= 0 ? `${currentIndex + 1} of ${listQuery.data?.total ?? orderedIds.length}` : null;

    function stepTo(id: string) {
        router.push(`/app/right-sizing/${id}${queryString ? `?${queryString}` : ""}`);
    }

    async function setStatus(status: RecommendationStatus, snoozeUntil?: string) {
        setBusy(status);
        try {
            await updateMutation.mutateAsync({ id: r.id, status, snoozeUntil });
            toast.success(`Recommendation ${status}`);
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "Failed to update");
        } finally {
            setBusy(null);
        }
    }

    return (
        <div className="space-y-6 p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <Button variant="outline" size="sm" onClick={() => router.push(backHref)}>
                    <ArrowLeft className="h-4 w-4" />
                    <span className="ml-1">Back to Right Sizing</span>
                </Button>
                <div className="flex items-center gap-2">
                    {positionLabel && <span className="text-xs text-muted-foreground">{positionLabel}</span>}
                    <Button variant="outline" size="sm" disabled={!prevId} onClick={() => prevId && stepTo(prevId)}>
                        <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <Button variant="outline" size="sm" disabled={!nextId} onClick={() => nextId && stepTo(nextId)}>
                        <ChevronRight className="h-4 w-4" />
                    </Button>
                </div>
            </div>

            <div className="space-y-1">
                <h1 className="text-2xl font-bold tracking-tight">
                    {RESOURCE_TYPE_LABELS[r.resourceType] ?? r.resourceType}: {r.name || r.resourceId}
                </h1>
                <div className="flex flex-wrap items-center gap-2">
                    <FindingBadge finding={r.finding} />
                    <RiskBadge risk={r.riskLevel} />
                    <StatusBadge status={r.status} />
                    <span className="text-xs text-muted-foreground">{Math.round(r.confidence * 100)}% confidence</span>
                </div>
            </div>

            {r.finding !== "optimized" && (
                <Card>
                    <CardContent className="flex flex-col gap-3 pt-6 sm:flex-row sm:items-end sm:justify-between">
                        <div className="flex items-end gap-2">
                            <div>
                                <label className="text-xs text-muted-foreground">Snooze until</label>
                                <Input
                                    type="date"
                                    value={snoozeDate}
                                    onChange={(e) => setSnoozeDate(e.target.value)}
                                    className="h-9 w-40"
                                />
                            </div>
                            {/*
                              * Snooze, Dismiss and Approve all write the same row
                              * through PATCH /api/right-sizing/recommendations/:id,
                              * which enforces authorize('update', 'RightSizing') —
                              * the same permission the Run scan button on the list
                              * page needs. `data` is passed because these act on an
                              * existing recommendation: without it a conditional
                              * grant reads as permitted and the control enables on
                              * rows the API will refuse.
                              */}
                            <GatedButton
                                action="update"
                                subject="RightSizing"
                                data={r as unknown as Record<string, unknown>}
                                variant="outline"
                                disabled={!snoozeDate || busy !== null}
                                onClick={() => setStatus("snoozed", snoozeDate)}
                            >
                                {busy === "snoozed" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clock className="h-4 w-4" />}
                                <span className="ml-1">Snooze</span>
                            </GatedButton>
                        </div>
                        <div className="flex gap-2">
                            <GatedButton
                                action="update"
                                subject="RightSizing"
                                data={r as unknown as Record<string, unknown>}
                                variant="outline"
                                disabled={busy !== null}
                                onClick={() => setStatus("dismissed")}
                            >
                                {busy === "dismissed" ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                                <span className="ml-1">Dismiss</span>
                            </GatedButton>
                            <GatedButton
                                action="update"
                                subject="RightSizing"
                                data={r as unknown as Record<string, unknown>}
                                disabled={busy !== null}
                                onClick={() => setStatus("approved")}
                            >
                                {busy === "approved" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                                <span className="ml-1">Approve</span>
                            </GatedButton>
                        </div>
                    </CardContent>
                </Card>
            )}

            <Card>
                <CardContent className="pt-6">
                    <p className="text-sm">{r.rationale}</p>
                </CardContent>
            </Card>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Card>
                    <CardContent className="pt-6">
                        <div className="text-xs text-muted-foreground">Current cost / mo</div>
                        <div className="text-lg font-semibold">{formatMoney(r.currentMonthlyCost)}</div>
                    </CardContent>
                </Card>
                <Card>
                    <CardContent className="pt-6">
                        <div className="text-xs text-muted-foreground">Est. savings / mo</div>
                        <div className="text-lg font-semibold text-emerald-600">{formatMoney(r.estimatedMonthlySavings)}</div>
                    </CardContent>
                </Card>
            </div>
            {pricingUnavailable && (
                <p className="text-xs text-amber-600">
                    Pricing unavailable for this resource — savings could not be computed. The finding is still valid.
                </p>
            )}

            <Card>
                <CardContent className="space-y-3 pt-6">
                    <div className="text-xs font-semibold uppercase text-muted-foreground">Resource</div>
                    <ResourceContextPanel recommendation={r} resource={resource} account={account} />
                </CardContent>
            </Card>

            <Card>
                <CardContent className="space-y-3 pt-6">
                    <div className="text-xs font-semibold uppercase text-muted-foreground">
                        Metrics ({Number((r.metricsSummary as unknown as MetricsSummary).coverageDays ?? 0).toFixed(1)}d observed)
                    </div>
                    <MetricCharts metricsSummary={r.metricsSummary as unknown as MetricsSummary} />
                </CardContent>
            </Card>

            <Card>
                <CardContent className="space-y-2 pt-6">
                    <div className="text-xs font-semibold uppercase text-muted-foreground">Why this finding fired</div>
                    <ul className="list-inside list-disc space-y-1 text-sm text-muted-foreground">
                        {reasoningLines.map((line, i) => (
                            <li key={i}>{line}</li>
                        ))}
                    </ul>
                </CardContent>
            </Card>
        </div>
    );
}
