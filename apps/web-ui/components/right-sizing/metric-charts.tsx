"use client";

import { MetricBarTile } from "@/components/shared/metric-bar-tile";
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

export function MetricCharts({ metricsSummary }: { metricsSummary: MetricsSummary }) {
    const present = SIGNALS.filter((s) => (metricsSummary[s.key] as SignalSummary | null | undefined) != null);

    if (present.length === 0) {
        return <p className="text-sm text-muted-foreground">No CloudWatch signals were available for this resource.</p>;
    }

    return (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {present.map((s) => (
                <MetricBarTile key={s.key} label={s.label} isPercent={s.isPercent} signal={metricsSummary[s.key] as SignalSummary} />
            ))}
        </div>
    );
}
