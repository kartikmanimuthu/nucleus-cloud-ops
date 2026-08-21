"use client";

import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import type { SignalSummary } from "@/lib/right-sizing/types";

function round(n: number): number {
    return Number(n.toFixed(2));
}

/**
 * One avg/p95/p99/max bar-chart tile for a single metric signal. Lifted out
 * of right-sizing/metric-charts.tsx once a second module (Network Pulse)
 * needed the identical tile for a differently-shaped signal set — same
 * `SignalSummary` shape, just fed from throughput instead of CPU/memory/etc.
 */
export function MetricBarTile({ label, isPercent, signal }: { label: string; isPercent: boolean; signal: SignalSummary }) {
    const data = [
        { stat: "avg", value: round(signal.avg) },
        { stat: "p95", value: round(signal.p95) },
        { stat: "p99", value: round(signal.p99) },
        { stat: "max", value: round(signal.max) },
    ];
    return (
        <div className="rounded-md border p-3">
            <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">{label}</div>
            <div className="h-32 w-full">
                <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data}>
                        <XAxis dataKey="stat" tick={{ fontSize: 11 }} />
                        <YAxis domain={isPercent ? [0, 100] : undefined} tick={{ fontSize: 11 }} />
                        <Tooltip />
                        <Bar dataKey="value" fill="#3b82f6" radius={[2, 2, 0, 0]} />
                    </BarChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
}
