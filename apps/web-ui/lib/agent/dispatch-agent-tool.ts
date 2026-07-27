/**
 * dispatch_agent — the sub-agent fan-out tool.
 *
 * One sub-agent per tool call, deliberately: the orchestrator emits N calls in a
 * single turn and ToolNode's existing concurrency performs the fan-out, so there
 * is no second concurrency mechanism and each sub-agent gets its own tool card
 * in the UI for free.
 *
 * Budget exhaustion NEVER fails the run. The tool returns an instruction to do
 * the work serially, so behaviour degrades to the pre-sub-agent baseline.
 */
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { Semaphore } from './concurrency';
import { runSubagent, type SubagentTranscriptEntry } from './subagent';
import type { SubagentBudgetConfig } from './subagent-budget';
import { redactTranscript } from './subagent-redact';

export interface SubagentEvent {
    id: string;
    role: string;
    task: string;
    status: 'running' | 'done' | 'failed';
    toolCount: number;
    tokensIn: number;
    tokensOut: number;
    summary?: string;
    transcript?: SubagentTranscriptEntry[];
}

/**
 * Tokens a single model call carries beyond the transcript: the sub-agent system
 * prompt, the standalone task brief, and the report instructions.
 */
const PROMPT_BASE_TOKENS = 2_000;

/**
 * Tokens one tool result contributes. Derived, not guessed: `subagent.ts` caps
 * every tool output at SUBAGENT_TOOL_OUTPUT_MAX_CHARS (4000) before it enters the
 * message list, and ~4 characters per token is the standard approximation.
 */
const TOOL_RESULT_TOKENS = 1_000;

/**
 * Worst-case token cost of one sub-agent, used to reserve capacity at dispatch.
 *
 * A sub-agent re-sends its whole transcript on every model call, so cost is
 * QUADRATIC in the iteration count, not linear: iteration i carries i-1 prior tool
 * results. Summing over N iterations gives N·base + (N²/2)·result. A linear
 * estimate looks safe at the default N=8 and badly under-reserves at the maximum
 * N=16 — which is precisely where a ceiling needs to hold.
 *
 * Over-estimating costs only CONCURRENT admission, never throughput: the
 * reservation is released and replaced by actual usage the moment the sub-agent
 * finishes, so later dispatches in the same run reserve against real numbers.
 */
export function estimateSubagentTokens(budget: SubagentBudgetConfig): number {
    const n = Math.max(1, budget.subagentMaxIterations);
    return n * PROMPT_BASE_TOKENS + Math.ceil((n * n) / 2) * TOOL_RESULT_TOKENS;
}

/** Capacity held by one in-flight sub-agent, returned when it settles. */
export interface BudgetReservation {
    /**
     * Release this reservation and charge what the sub-agent actually used.
     * Idempotent — a double settle can neither mint budget nor double-charge.
     */
    settle(tokensIn: number, tokensOut: number): void;
}

export interface RunBudgetLedger {
    tryReserve(): { ok: true; reservation: BudgetReservation } | { ok: false; reason: string };
    semaphore: Semaphore;
}

/**
 * Per-run ledger. Runs execute on a single ECS replica, so in-process counters
 * are sufficient — no distributed coordination needed.
 */
export function createRunBudgetLedger(budget: SubagentBudgetConfig): RunBudgetLedger {
    let dispatched = 0;
    /** Reconciled usage, from sub-agents that have finished. */
    let tokensSpent = 0;
    /** Estimated capacity held by sub-agents still in flight. */
    let tokensReserved = 0;
    const estimate = estimateSubagentTokens(budget);
    const semaphore = new Semaphore(budget.maxConcurrentSubagents);

    return {
        tryReserve() {
            if (!budget.enabled) {
                return { ok: false, reason: 'sub-agents are disabled for this organization' };
            }
            if (dispatched >= budget.maxSubagentsPerRun) {
                return { ok: false, reason: `per-run sub-agent limit reached (${budget.maxSubagentsPerRun})` };
            }
            // Gate on spent + IN-FLIGHT + this one. ToolNode dispatches a turn's
            // dispatch_agent calls concurrently, so gating on settled spend alone
            // consults the budget only after the fan-out it exists to bound has
            // already been granted — every reservation would see tokensSpent === 0.
            if (tokensSpent + tokensReserved + estimate > budget.maxSubagentTokensPerRun) {
                const reason = estimate > budget.maxSubagentTokensPerRun
                    // Not exhaustion — a misconfiguration. Nothing has run, and
                    // nothing ever will, so name the two settings involved rather
                    // than reporting an empty budget as spent.
                    ? `one sub-agent's estimated cost (${estimate} tokens at ${budget.subagentMaxIterations} iterations) exceeds the entire run token budget (${budget.maxSubagentTokensPerRun}) — raise the token budget or lower the iteration limit`
                    : `sub-agent token budget exhausted (${budget.maxSubagentTokensPerRun})`;
                return { ok: false, reason };
            }

            // Check and increment stay in one synchronous block. An `await`
            // anywhere between them would let two concurrent callers observe the
            // same free capacity and both be admitted.
            dispatched++;
            tokensReserved += estimate;

            let settled = false;
            return {
                ok: true,
                reservation: {
                    settle(tokensIn: number, tokensOut: number) {
                        // Guard against a double release: the dispatch tool settles
                        // in a `finally`, and an unusual path could reach it twice.
                        // Releasing twice would mint capacity that was never held.
                        if (settled) return;
                        settled = true;
                        tokensReserved -= estimate;
                        tokensSpent += tokensIn + tokensOut;
                    },
                },
            };
        },
        semaphore,
    };
}

export interface DispatchAgentDeps {
    model: unknown;
    subagentTools: Array<{ name: string; invoke: (args: Record<string, unknown>) => Promise<unknown> }>;
    ledger: RunBudgetLedger;
    budget: SubagentBudgetConfig;
    onSubagentEvent?: (event: SubagentEvent) => void;
}

const DEGRADE_PREFIX = 'Sub-agent budget exhausted';

export function createDispatchAgentTool(deps: DispatchAgentDeps) {
    return tool(
        async ({ role, task, expectedOutput }: { role: string; task: string; expectedOutput: string }) => {
            const reservation = deps.ledger.tryReserve();
            if (!reservation.ok) {
                return `${DEGRADE_PREFIX}: ${reservation.reason}. Perform this work yourself, serially, using your own tools.`;
            }

            const id = randomUUID();
            // The sink is supplied by the caller (the chat route enqueues onto a
            // ReadableStream, which throws once the client disconnects). Swallow
            // here rather than at each call site: the first emit runs before the
            // try below, so a throwing sink would otherwise reject the tool call
            // itself — consuming a budget reservation and handing the model a
            // "fix your mistakes" error instead of the do-it-yourself instruction.
            const emit = (event: Partial<SubagentEvent> & Pick<SubagentEvent, 'status'>) => {
                try {
                    deps.onSubagentEvent?.({
                        id, role, task, toolCount: 0, tokensIn: 0, tokensOut: 0, ...event,
                    });
                } catch (err) {
                    console.warn(`[dispatch_agent] progress sink threw (ignored): ${err instanceof Error ? err.message : String(err)}`);
                }
            };

            emit({ status: 'running' });

            // Actual usage, reconciled against the reservation in the `finally`
            // below. A sub-agent that throws before reporting usage spent nothing
            // we can attribute, so its reservation comes back whole.
            let actualIn = 0;
            let actualOut = 0;

            try {
                const result = await deps.ledger.semaphore.run(() => runSubagent(
                    { role, task, expectedOutput },
                    {
                        model: deps.model as never,
                        tools: deps.subagentTools,
                        budget: deps.budget,
                        onEvent: progress => emit({ status: 'running', ...progress }),
                    },
                ));

                actualIn = result.tokensIn;
                actualOut = result.tokensOut;

                emit({
                    status: result.status === 'failed' ? 'failed' : 'done',
                    toolCount: result.toolCount,
                    tokensIn: result.tokensIn,
                    tokensOut: result.tokensOut,
                    summary: result.report,
                    transcript: result.transcript,
                });

                // Redact HERE, not only in the repository. This return value becomes a
                // ToolMessage in the orchestrator's message list, and the chat route
                // persists every new message verbatim — reaching two at-rest sinks the
                // repository never sees: `chat_messages` (30-day TTL, and replayed to
                // the browser by /api/threads/[threadId]/history) and the LangGraph
                // checkpoint tables, which have no TTL at all. Redacting at the source
                // covers all three sinks and the orchestrator's own context.
                return redactTranscript(result.report);
            } catch (error) {
                // runSubagent is already total, but a semaphore or emit failure must
                // not propagate into ToolNode and abort the orchestrator's turn.
                const message = error instanceof Error ? error.message : String(error);
                console.error(`[dispatch_agent] "${role}" failed: ${message}`);
                emit({ status: 'failed', summary: message });
                return `The sub-agent "${role}" failed: ${message}. Continue with the information you already have, or perform this work yourself.`;
            } finally {
                // Must run on EVERY exit path — success, internal failure, timeout,
                // and the catch above. A reservation stranded by a failed sub-agent
                // starves the rest of the run of capacity it never actually used.
                reservation.reservation.settle(actualIn, actualOut);
            }
        },
        {
            name: 'dispatch_agent',
            description: `Delegate an INDEPENDENT read-only investigation to a sub-agent that works in its own context and returns a compressed findings report.

Use this when the task splits into parts that do not depend on each other — one account each, one region each, one service each. Emit SEVERAL dispatch_agent calls in a SINGLE turn and they run in parallel; that is the entire point.

Do NOT use it for:
- anything that changes state (sub-agents are read-only — do mutations yourself)
- work that depends on another sub-agent's output (they cannot see each other)
- a single quick lookup you could do in one tool call

CRITICAL: "task" must be completely self-contained. The sub-agent sees NONE of this conversation — no account ids, no prior findings, no user context unless you write them into the task. A vague brief returns a useless report.`,
            schema: z.object({
                role: z.string().describe('Short identity for this sub-agent, e.g. "EC2 idle-resource auditor for account 123456789012"'),
                task: z.string().describe('Complete standalone brief: what to investigate, which account ids and regions, which tools to prefer, and any constraints. Assume zero shared context.'),
                expectedOutput: z.string().describe('Exactly what the report must contain, e.g. "instance ids with average CPU below 5% over 14 days, with the metric value for each"'),
            }),
        },
    );
}
