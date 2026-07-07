"use client";

import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import type { MetricsSummary, SignalSummary } from "@/lib/right-sizing/types";

const SIGNALS: { key: keyof MetricsSummary; label: string; isPercent: boolean }[] = [
    { key: "cpu", label: "CPU %", isPercent: true },
    { key: "memory", label: "Memory %", isPercent: true },
    { key: "throughputPercent", label: "Throughput %", isPercent: true },
    { key: "burstBalance", label: "Burst Balance %", isPercent: true },
    { key: "networkIn", label: "Network In (bytes)", isPercent: false },
    { key: "networkOut", label: "Network Out (bytes)", isPercent: false },
    { key: "diskReadOps", label: "Disk Read Ops", isPercent: false },
    { key: "diskWriteOps", label: "Disk Write Ops", isPercent: false },
    { key: "iops", label: "IOPS", isPercent: false },
    { key: "connections", label: "Connections", isPercent: false },
    { key: "freeableMemory", label: "Freeable Memory (bytes)", isPercent: false },
];

function round(n: number): number {
    return Number(n.toFixed(2));
}

export function MetricCharts({ metricsSummary }: { metricsSummary: MetricsSummary }) {
    const present = SIGNALS.filter((s) => (metricsSummary[s.key] as SignalSummary | null | undefined) != null);

    if (present.length === 0) {
        return <p className="text-sm text-muted-foreground">No CloudWatch signals were available for this resource.</p>;
    }

    return (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {present.map((s) => {
                const signal = metricsSummary[s.key] as SignalSummary;
                const data = [
                    { stat: "avg", value: round(signal.avg) },
                    { stat: "p95", value: round(signal.p95) },
                    { stat: "p99", value: round(signal.p99) },
                    { stat: "max", value: round(signal.max) },
                ];
                return (
                    <div key={s.key} className="rounded-md border p-3">
                        <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">{s.label}</div>
                        <div className="h-32 w-full">
                            <ResponsiveContainer width="100%" height="100%">
                                <BarChart data={data}>
                                    <XAxis dataKey="stat" tick={{ fontSize: 11 }} />
                                    <YAxis domain={s.isPercent ? [0, 100] : undefined} tick={{ fontSize: 11 }} />
                                    <Tooltip />
                                    <Bar dataKey="value" fill="#3b82f6" radius={[2, 2, 0, 0]} />
                                </BarChart>
                            </ResponsiveContainer>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
