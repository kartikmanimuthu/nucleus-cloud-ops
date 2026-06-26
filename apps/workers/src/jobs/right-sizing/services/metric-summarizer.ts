// workers/src/jobs/right-sizing/services/metric-summarizer.ts
//
// Pure metric summarizer (RS-009). Reduces raw per-period series into the compact
// MetricsSummary consumed by the engine and persisted on each recommendation.
// No I/O, no Date.now/random — fully deterministic and unit-testable.
import type { MetricsSummary, SignalKey, SignalSummary } from '../types.js';

/** Percentile (0..1) of a numeric series using nearest-rank. Pure. */
export function percentile(values: number[], p: number): number {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const rank = Math.ceil(p * sorted.length);
    const idx = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
    return sorted[idx];
}

function summarizeSignal(values: number[] | undefined): SignalSummary | null {
    if (!values || values.length === 0) return null;
    const sum = values.reduce((a, b) => a + b, 0);
    return {
        avg: sum / values.length,
        p95: percentile(values, 0.95),
        p99: percentile(values, 0.99),
        max: values.reduce((a, b) => Math.max(a, b), -Infinity),
        count: values.length,
    };
}

export interface SummarizeOptions {
    lookbackDays: number;
    periodSeconds: number;
}

const ALL_SIGNALS: SignalKey[] = [
    'cpu',
    'memory',
    'networkIn',
    'networkOut',
    'diskReadOps',
    'diskWriteOps',
    'connections',
    'freeableMemory',
    'iops',
    'throughputPercent',
    'burstBalance',
];

export function summarize(
    metrics: Partial<Record<SignalKey, number[]>>,
    opts: SummarizeOptions
): MetricsSummary {
    const summary: MetricsSummary = { coverageDays: 0, datapointDensity: 0 };

    let maxCount = 0;
    for (const sig of ALL_SIGNALS) {
        const s = summarizeSignal(metrics[sig]);
        // Assign onto the summary object under the same key.
        (summary as unknown as Record<string, SignalSummary | null>)[sig] = s;
        if (s && s.count > maxCount) maxCount = s.count;
    }

    const expectedDatapoints = Math.max(1, Math.floor((opts.lookbackDays * 86400) / opts.periodSeconds));
    summary.coverageDays = Math.min(opts.lookbackDays, (maxCount * opts.periodSeconds) / 86400);
    summary.datapointDensity = Math.min(1, maxCount / expectedDatapoints);

    return summary;
}
