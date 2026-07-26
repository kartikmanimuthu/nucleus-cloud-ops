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

export interface RunBudgetLedger {
    tryReserve(): { ok: true } | { ok: false; reason: string };
    recordSpend(tokensIn: number, tokensOut: number): void;
    semaphore: Semaphore;
}

/**
 * Per-run ledger. Runs execute on a single ECS replica, so in-process counters
 * are sufficient — no distributed coordination needed.
 */
export function createRunBudgetLedger(budget: SubagentBudgetConfig): RunBudgetLedger {
    let dispatched = 0;
    let tokensSpent = 0;
    const semaphore = new Semaphore(budget.maxConcurrentSubagents);

    return {
        tryReserve() {
            if (!budget.enabled) {
                return { ok: false, reason: 'sub-agents are disabled for this organization' };
            }
            if (dispatched >= budget.maxSubagentsPerRun) {
                return { ok: false, reason: `per-run sub-agent limit reached (${budget.maxSubagentsPerRun})` };
            }
            if (tokensSpent >= budget.maxSubagentTokensPerRun) {
                return { ok: false, reason: `sub-agent token budget exhausted (${budget.maxSubagentTokensPerRun})` };
            }
            dispatched++;
            return { ok: true };
        },
        recordSpend(tokensIn: number, tokensOut: number) {
            tokensSpent += tokensIn + tokensOut;
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

                deps.ledger.recordSpend(result.tokensIn, result.tokensOut);

                emit({
                    status: result.status === 'failed' ? 'failed' : 'done',
                    toolCount: result.toolCount,
                    tokensIn: result.tokensIn,
                    tokensOut: result.tokensOut,
                    summary: result.report,
                    transcript: result.transcript,
                });

                return result.report;
            } catch (error) {
                // runSubagent is already total, but a semaphore or emit failure must
                // not propagate into ToolNode and abort the orchestrator's turn.
                const message = error instanceof Error ? error.message : String(error);
                console.error(`[dispatch_agent] "${role}" failed: ${message}`);
                emit({ status: 'failed', summary: message });
                return `The sub-agent "${role}" failed: ${message}. Continue with the information you already have, or perform this work yourself.`;
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
