/**
 * Per-run LLM timing accumulator.
 *
 * llmAuditLog already measures latency and tokens for every model call, but
 * throws the numbers away unless LLM_AUDIT is enabled. This module keeps a
 * lightweight always-on aggregate so a run's wall time can be attributed to
 * specific graph nodes — the baseline needed to tell whether parallelism
 * actually helped.
 *
 * Keyed by threadId because runs are concurrent within one process.
 */

export interface NodeTiming {
    calls: number;
    ms: number;
    tokensIn: number;
    tokensOut: number;
}

export interface RunTimingSummary {
    totalLlmMs: number;
    totalTokensIn: number;
    totalTokensOut: number;
    byNode: Record<string, NodeTiming>;
}

/** Backstop against unbounded growth if a run never reaches its teardown. */
const MAX_TRACKED_RUNS = 200;

const runs = new Map<string, Record<string, NodeTiming>>();

export function recordNodeTiming(
    threadId: string | undefined,
    node: string,
    latencyMs: number,
    tokensIn: number,
    tokensOut: number,
): void {
    if (!threadId) return;

    let byNode = runs.get(threadId);
    if (!byNode) {
        if (runs.size >= MAX_TRACKED_RUNS) {
            // Evict the oldest insertion — Map preserves insertion order.
            const oldest = runs.keys().next().value;
            if (oldest !== undefined) runs.delete(oldest);
        }
        byNode = {};
    } else {
        // Refresh position: Map keeps INSERTION order, and .set() on an
        // existing key does not move it. Without this, eviction targets the
        // oldest-STARTED run — which is exactly the long run we most want to
        // measure. Delete-then-set makes it least-recently-ACTIVE.
        runs.delete(threadId);
    }
    runs.set(threadId, byNode);

    const entry = byNode[node] ?? { calls: 0, ms: 0, tokensIn: 0, tokensOut: 0 };
    entry.calls += 1;
    entry.ms += latencyMs;
    entry.tokensIn += tokensIn;
    entry.tokensOut += tokensOut;
    byNode[node] = entry;
}

export function summarizeRun(threadId: string): RunTimingSummary | null {
    const byNode = runs.get(threadId);
    if (!byNode) return null;

    let totalLlmMs = 0;
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    for (const entry of Object.values(byNode)) {
        totalLlmMs += entry.ms;
        totalTokensIn += entry.tokensIn;
        totalTokensOut += entry.tokensOut;
    }

    return { totalLlmMs, totalTokensIn, totalTokensOut, byNode };
}

export function logRunSummary(threadId: string): void {
    const summary = summarizeRun(threadId);
    runs.delete(threadId);
    if (!summary) return;

    const rows = Object.entries(summary.byNode)
        .sort((a, b) => b[1].ms - a[1].ms)
        .map(([node, t]) =>
            `   ${node.padEnd(12)} calls=${String(t.calls).padStart(3)}  llm=${(t.ms / 1000).toFixed(1)}s  in=${t.tokensIn}  out=${t.tokensOut}`);

    console.log(
        `\n📊 [RUN SUMMARY] thread=${threadId}\n` +
        `   TOTAL        llm=${(summary.totalLlmMs / 1000).toFixed(1)}s  in=${summary.totalTokensIn}  out=${summary.totalTokensOut}\n` +
        rows.join('\n'),
    );
}

/** Test seam. */
export function __resetRunTimingsForTests(): void {
    runs.clear();
}
