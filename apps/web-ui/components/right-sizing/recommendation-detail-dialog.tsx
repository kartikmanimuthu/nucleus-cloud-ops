"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Check, X, Clock, Loader2 } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { toast } from "sonner";
import { formatMoney, FindingBadge, RiskBadge, StatusBadge, RESOURCE_TYPE_LABELS } from "./shared";
import type { RightSizingRecommendation, RecommendationStatus } from "@/lib/db/repositories/right-sizing/interface";

interface SignalSummary {
    avg: number;
    p95: number;
    p99: number;
    max: number;
    count: number;
}

function pctSignals(metricsSummary: Record<string, unknown>): { name: string; p95: number; avg: number }[] {
    const out: { name: string; p95: number; avg: number }[] = [];
    const pctKeys: Record<string, string> = {
        cpu: "CPU %",
        memory: "Memory %",
        throughputPercent: "Throughput %",
        burstBalance: "Burst %",
    };
    for (const [key, label] of Object.entries(pctKeys)) {
        const s = metricsSummary[key] as SignalSummary | null | undefined;
        if (s && typeof s.p95 === "number") out.push({ name: label, p95: Number(s.p95.toFixed(1)), avg: Number(s.avg.toFixed(1)) });
    }
    return out;
}

function ConfigTable({ title, config }: { title: string; config: Record<string, unknown> | null | undefined }) {
    const entries = config ? Object.entries(config).filter(([, v]) => v != null) : [];
    return (
        <div className="rounded-md border p-3">
            <div className="mb-2 text-xs font-semibold uppercase text-muted-foreground">{title}</div>
            {entries.length === 0 ? (
                <div className="text-sm text-muted-foreground">—</div>
            ) : (
                <dl className="space-y-1">
                    {entries.map(([k, v]) => (
                        <div key={k} className="flex justify-between text-sm">
                            <dt className="text-muted-foreground">{k}</dt>
                            <dd className="font-medium">{String(v)}</dd>
                        </div>
                    ))}
                </dl>
            )}
        </div>
    );
}

export function RecommendationDetailDialog({
    recommendation,
    open,
    onOpenChange,
    onUpdated,
    canReview,
}: {
    recommendation: RightSizingRecommendation | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onUpdated: () => void;
    canReview: boolean;
}) {
    const [busy, setBusy] = useState<RecommendationStatus | null>(null);
    const [snoozeDate, setSnoozeDate] = useState("");

    if (!recommendation) return null;
    const r = recommendation;
    const chartData = pctSignals(r.metricsSummary as Record<string, unknown>);
    const pricingUnavailable = r.currentMonthlyCost == null;

    async function setStatus(status: RecommendationStatus, snoozeUntil?: string) {
        setBusy(status);
        try {
            const res = await fetch(`/api/right-sizing/recommendations/${r.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ status, snoozeUntil }),
            });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json.error || "Update failed");
            toast.success(`Recommendation ${status}`);
            onUpdated();
            onOpenChange(false);
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "Failed to update");
        } finally {
            setBusy(null);
        }
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        {RESOURCE_TYPE_LABELS[r.resourceType] ?? r.resourceType}: {r.name || r.resourceId}
                    </DialogTitle>
                    <DialogDescription className="flex flex-wrap items-center gap-2 pt-1">
                        <FindingBadge finding={r.finding} />
                        <RiskBadge risk={r.riskLevel} />
                        <StatusBadge status={r.status} />
                        <span className="text-xs text-muted-foreground">
                            {Math.round(r.confidence * 100)}% confidence · {r.region} · {r.accountId}
                        </span>
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4">
                    <div className="rounded-md bg-muted/40 p-3 text-sm">{r.rationale}</div>

                    <div className="grid grid-cols-2 gap-3">
                        <div className="rounded-md border p-3">
                            <div className="text-xs text-muted-foreground">Current cost / mo</div>
                            <div className="text-lg font-semibold">{formatMoney(r.currentMonthlyCost)}</div>
                        </div>
                        <div className="rounded-md border p-3">
                            <div className="text-xs text-muted-foreground">Est. savings / mo</div>
                            <div className="text-lg font-semibold text-emerald-600">{formatMoney(r.estimatedMonthlySavings)}</div>
                        </div>
                    </div>
                    {pricingUnavailable && (
                        <p className="text-xs text-amber-600">
                            Pricing unavailable for this resource — savings could not be computed. The finding is still valid.
                        </p>
                    )}

                    <div className="grid grid-cols-2 gap-3">
                        <ConfigTable title="Current" config={r.currentConfig as Record<string, unknown>} />
                        <ConfigTable title="Recommended" config={r.recommendedConfig as Record<string, unknown> | null} />
                    </div>

                    {chartData.length > 0 && (
                        <div>
                            <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                                Utilization (avg vs p95 over {Number((r.metricsSummary as Record<string, unknown>).coverageDays ?? 0)}d)
                            </div>
                            <div className="h-40 w-full">
                                <ResponsiveContainer width="100%" height="100%">
                                    <BarChart data={chartData}>
                                        <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                                        <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} />
                                        <Tooltip />
                                        <Bar dataKey="avg" fill="#94a3b8" name="avg" radius={[2, 2, 0, 0]} />
                                        <Bar dataKey="p95" name="p95" radius={[2, 2, 0, 0]}>
                                            {chartData.map((_, i) => (
                                                <Cell key={i} fill="#3b82f6" />
                                            ))}
                                        </Bar>
                                    </BarChart>
                                </ResponsiveContainer>
                            </div>
                        </div>
                    )}
                </div>

                {canReview && r.finding !== "optimized" && (
                    <DialogFooter className="flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
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
                            <Button
                                variant="outline"
                                disabled={!snoozeDate || busy !== null}
                                onClick={() => setStatus("snoozed", snoozeDate)}
                            >
                                {busy === "snoozed" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clock className="h-4 w-4" />}
                                <span className="ml-1">Snooze</span>
                            </Button>
                        </div>
                        <div className="flex gap-2">
                            <Button variant="outline" disabled={busy !== null} onClick={() => setStatus("dismissed")}>
                                {busy === "dismissed" ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
                                <span className="ml-1">Dismiss</span>
                            </Button>
                            <Button disabled={busy !== null} onClick={() => setStatus("approved")}>
                                {busy === "approved" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                                <span className="ml-1">Approve</span>
                            </Button>
                        </div>
                    </DialogFooter>
                )}
            </DialogContent>
        </Dialog>
    );
}
