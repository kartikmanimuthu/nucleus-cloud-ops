/**
 * Agent Ops — Deep Run Executor
 *
 * Headless driver for a deep-mode run. The plan-mode sibling is agent-executor.ts's
 * executeAgentRun; this one differs in three ways:
 *
 *   1. It consumes the deepagents v3 PROJECTIONS (messages / toolCalls / subagents /
 *      values) rather than v2 streamEvents, because that is where sub-agents and
 *      real tool callIds are exposed.
 *   2. Every projection is consumed in its OWN task inside Promise.all, and every
 *      per-item handle is collected into a watcher array that is awaited AFTER the
 *      loop it came from. Awaiting a handle inside its own loop serialises the run:
 *      app/api/chat/deep-stream.ts documents the measured deadlocks — awaiting
 *      `message.text` resolves the whole message, and awaiting a sub-agent's output
 *      inside the subagents loop blocks every later sub-agent behind it.
 *   3. Interrupts are per-action, so the pending set is read from the checkpoint via
 *      hitl.ts's pendingActions() and stored on the run's approvalRequest.
 *
 * WRITER DISCIPLINE: the DeepEventRecorder is the SOLE writer of a deep run's rows.
 * It owns the per-run `metadata.seq` counter that the timeline sorts on, so nothing
 * here calls recordAndEmit directly — run start, cancellation and errors go through
 * recorder.raw(), and the terminal summary through recorder.final(), exactly once.
 */
import { HumanMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { createDeepExecutorGraph } from './deep-executor-graph';
import {
    createDeepEventRecorder,
    type DeepEventRecorder,
    type DeepTodo,
} from './deep-event-recorder';
import { recordAndEmit } from './record-and-emit';
import { agentOpsService } from './agent-ops-service';
import { registerRun, cleanupRun, isAborted } from './run-manager';
import { resolveMaxIterations } from './agent-ops-defaults';
// Shared with plan mode on purpose: deriveUserId keys long-term memory and
// resolveRunModel honours the tenant's Agent Ops default model. Both are single
// definitions in agent-executor.ts so the two modes cannot drift apart.
import { deriveUserId, resolveRunModel } from './agent-executor';
import { hasPendingInterrupt, pendingActions, type ResumeMap } from '@/lib/agent/deep/hitl';
import type {
    DeepProjections,
    MessageHandle,
    SubagentHandle,
    ToolCallHandle,
} from '@/lib/agent/deep/projections';
import type { GraphConfig } from '@/lib/agent/agent-shared';
import type { AgentOpsRun } from './types';
import type { GatewayEventBus } from '@/lib/gateway/event-bus';

/** How often the run's DB status is re-read so a cancel on another replica lands here. */
const CANCEL_POLL_INTERVAL_MS = 5_000;

/** Sub-agent summaries are already long-form; cap what reaches a row. */
const MAX_SUBAGENT_SUMMARY = 4000;

/**
 * Upper bound on the whole projection drain (`consumeDeepRun`'s Promise.all over
 * messages / toolCalls / subagents / values). This is the fix for the failure that
 * actually happened in production: a run that dispatched ZERO sub-agents left
 * `run.subagents`'s `for await` open forever (an async iterable with nothing to
 * yield does not necessarily complete), so the Promise.all — and the whole run —
 * hung at 0% CPU with no error, stranding the DB row at `in_progress` indefinitely.
 * A legitimate deep run can run for many minutes (sub-agents, many tool calls), so
 * this must stay generous: it is set well above FALLBACK_MAX_ITERATIONS worth of
 * model/tool steps at a realistic per-step wall-clock cost. Expiry does NOT throw —
 * it stops waiting and lets the run settle with whatever was collected so far.
 */
export const PROJECTION_DRAIN_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Upper bound on `settle()`'s `graph.getState(...)` call. This is a single
 * checkpoint read, not an agent turn — it should resolve in milliseconds. The
 * failure being prevented: the agent can finish cleanly (its last recorded event is
 * `memory_save`) and still strand the run at `in_progress` forever if this one read
 * hangs, because `settle()` is the only code path that writes the terminal status.
 * Kept short since a hang here is pure infrastructure trouble, not agent work.
 */
const GET_STATE_TIMEOUT_MS = 10_000; // 10 seconds

/** Sentinel returned by `withTimeout` on expiry — never thrown, so callers choose what a timeout means. */
const TIMED_OUT = Symbol('timed-out');

/**
 * Race `promise` against a timer, resolving to `TIMED_OUT` instead of rejecting on
 * expiry. The timer is ALWAYS cleared (success, failure, or timeout) — a dangling
 * `setTimeout` keeps the Node process alive even after the real value has landed,
 * which is exactly the kind of stray handle this whole fix is trying to eliminate.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof TIMED_OUT>(resolve => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
    });
    return Promise.race([promise, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

export interface DeepConsumeResult {
    finalText: string;
    toolsUsed: string[];
    /**
     * Assistant model turns consumed, memory-middleware turns excluded and
     * sub-agent turns rolled up. This is the closest honest analogue to plan
     * mode's `iterations` — but the UNIT DIFFERS: plan mode counts executor
     * graph loops, deep mode has no such loop and counts model calls.
     */
    modelTurns: number;
    inputTokens: number;
    outputTokens: number;
    aborted: boolean;
    errors: string[];
}

function emptyResult(): DeepConsumeResult {
    return {
        finalText: '', toolsUsed: [], modelTurns: 0,
        inputTokens: 0, outputTokens: 0, aborted: false, errors: [],
    };
}

/**
 * Attach a no-op rejection handler to each handle RIGHT NOW.
 *
 * Every v3 handle rejects when the run is aborted, and a rejection with no handler
 * attached terminates the Node process (>= v15). deep-stream.ts measured exactly
 * this: "3 aborted `task` calls produced exactly 3 unhandledRejection: AbortError".
 * The handlers must be attached synchronously in the loop body that produced the
 * handle — attaching them after an `await` (a DB write, a whole sub-agent drain)
 * leaves a window in which a cancel kills the container. Values are still consumed
 * by the real `await`s further down; this only guarantees observation.
 */
function observe(...handles: Array<PromiseLike<unknown> | undefined>): void {
    for (const h of handles) {
        if (h) void Promise.resolve(h).catch(() => undefined);
    }
}

/**
 * DeepMemoryMiddleware's own reflector calls surface as message handles like any
 * agent turn (node `DeepMemoryMiddleware.before*` / `.after*`). They are NOT agent
 * output: `afterAgent` runs after the agent's last turn, so the save-phase handle is
 * the LAST in the projection and would otherwise become the run summary. Their
 * narration is already written by the onMemoryEvent sink as memory_recall /
 * memory_save rows. Mirrors deep-stream.ts.
 */
function memoryPhase(node: string | undefined): 'recall' | 'save' | null {
    const n = node ?? '';
    if (n.startsWith('DeepMemoryMiddleware.before')) return 'recall';
    if (n.startsWith('DeepMemoryMiddleware.after')) return 'save';
    return null;
}

/**
 * Everything the per-projection consumers share. `guard` funnels a failure into the
 * RUN's error list even when it happened inside a sub-agent, so one dead projection
 * (or one dead sub-agent) never takes the rest of the run's rows with it.
 */
interface ConsumeContext {
    recorder: DeepEventRecorder;
    signal: AbortSignal | undefined;
    guard(label: string, task: () => Promise<void>): Promise<void>;
}

/** Same normalisation deep-stream.ts applies, so a row and a chunk read alike. */
function outputText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object' && 'content' in value) {
        const c = (value as { content: unknown }).content;
        return typeof c === 'string' ? c : JSON.stringify(c);
    }
    return JSON.stringify(value ?? '');
}

/** Drain one text projection into the recorder, returning what it produced. */
async function drainText(
    stream: AsyncIterable<string>,
    write: (chunk: string) => Promise<void>,
): Promise<string> {
    let acc = '';
    for await (const chunk of stream) {
        if (!chunk) continue;
        acc += chunk;
        await write(chunk);
    }
    return acc;
}

async function consumeToolCall(
    call: ToolCallHandle,
    ctx: ConsumeContext,
    result: DeepConsumeResult,
    subagentId?: string,
): Promise<void> {
    // BEFORE the awaited recorder.toolCall DB write below: that await is a window in
    // which an abort would reject all three handles with nothing attached.
    observe(call.output, call.status, call.error);

    const args = call.input && typeof call.input === 'object'
        ? (call.input as Record<string, unknown>)
        : {};
    result.toolsUsed.push(call.name);
    await ctx.recorder.toolCall({ toolCallId: call.callId, toolName: call.name, args, subagentId });

    const [output, status, error] = await Promise.all([call.output, call.status, call.error]);

    let text: string;
    if (status === 'error') {
        text = `Error: ${error ?? 'tool failed'}`;
    } else if (call.name === 'task') {
        // `task` resolves to a LangGraph Command — framework internals
        // ({"lg_name":"Command","update":{...}}) that mean nothing in a timeline.
        // The sub-agent row carries the real result.
        const kind = (call.input as { subagent_type?: unknown } | null)?.subagent_type;
        text = `Delegated to ${String(kind ?? 'sub-agent')} — see the sub-agent entry for its findings.`;
    } else {
        text = outputText(output);
    }

    await ctx.recorder.toolResult({
        toolCallId: call.callId,
        toolName: call.name,
        output: text,
        status: status === 'error' ? 'error' : 'finished',
        subagentId,
    });
}

/**
 * Drain a message projection.
 *
 * Two rules, both load-bearing:
 *  - each message handle is pushed to `watchers` and never awaited inside the loop;
 *  - within a handle, `text` and `reasoning` are ITERATED concurrently. They are
 *    dual-interface — awaiting either resolves the whole message and blocks.
 *
 * Because handles therefore finish out of order, the run's final text is chosen by
 * POSITION (last non-empty message) rather than by whichever settled last.
 */
async function consumeMessages(
    messages: AsyncIterable<MessageHandle>,
    ctx: ConsumeContext,
    result: DeepConsumeResult,
    subagentId?: string,
): Promise<void> {
    const texts: string[] = [];
    const watchers: Promise<void>[] = [];
    let slot = 0;

    for await (const msg of messages) {
        // First statement in the loop body — usage is not awaited until both text
        // streams have drained, which for a long turn is minutes.
        observe(msg.usage);
        if (ctx.signal?.aborted) break;

        const phase = memoryPhase(msg.node);
        // Memory turns take no slot: they must never win the `finalText` scan below,
        // and they are not model turns the operator asked for.
        const mine = phase ? -1 : slot++;
        if (mine >= 0) {
            texts.push('');
            result.modelTurns += 1;
        }

        watchers.push(ctx.guard(`message[${phase ?? mine}]`, async () => {
            if (phase) {
                // Drained but DISCARDED: the onMemoryEvent sink already wrote this as a
                // memory_recall / memory_save row. Routing it through recorder.text would
                // duplicate it as an `execution` row and pollute the agent transcript.
                // Draining anyway is required — an abandoned stream is an unobserved handle.
                await Promise.all([
                    drainText(msg.text, async () => { }),
                    drainText(msg.reasoning, async () => { }),
                ]);
            } else {
                // Drain both streams concurrently — writing nothing per chunk — then persist
                // ONE row for the whole message. `drainText` already returns the accumulated
                // string; per-chunk writes here (the actual bug) turned a single assistant
                // message into ~4-char DB rows: 1,027 of them on one real run, at 4 chars
                // average / 16 max. That is right for deep-stream.ts's browser SSE, wrong for
                // persistence. `recorder.text`/`recorder.reasoning` already no-op on empty
                // content, so a message with nothing to say writes no row.
                const [text, reasoning] = await Promise.all([
                    drainText(msg.text, async () => { }),
                    drainText(msg.reasoning, async () => { }),
                ]);
                await Promise.all([
                    ctx.recorder.text(text, subagentId),
                    ctx.recorder.reasoning(reasoning, subagentId),
                ]);
                texts[mine] = text;
            }
            // Memory turns DO cost tokens, so their usage is still counted.
            const usage = await msg.usage;
            result.inputTokens += Number(usage?.input_tokens) || 0;
            result.outputTokens += Number(usage?.output_tokens) || 0;
        }));
    }

    await Promise.all(watchers);

    for (let i = texts.length - 1; i >= 0; i--) {
        if (texts[i]?.trim()) {
            result.finalText = texts[i];
            break;
        }
    }
}

async function consumeSubagent(
    sub: SubagentHandle,
    id: string,
    ctx: ConsumeContext,
    result: DeepConsumeResult,
): Promise<void> {
    // sub.output is not awaited until the whole sub-agent has drained — minutes of
    // exposure. Attach now, before the first await in this function.
    observe(sub.taskInput, sub.output);

    const rawTask = await sub.taskInput;
    const task = typeof rawTask === 'string' ? rawTask : JSON.stringify(rawTask ?? '');
    await ctx.recorder.subagent({
        id, role: sub.name, task, status: 'running', toolCount: 0, tokensIn: 0, tokensOut: 0,
    });

    // Token/tool totals are the sub-agent's own; only toolsUsed rolls up to the run.
    const inner = emptyResult();

    const drainTools = async () => {
        const watchers: Promise<void>[] = [];
        for await (const call of sub.toolCalls) {
            observe(call.output, call.status, call.error);
            if (ctx.signal?.aborted) break;
            // Collected, never awaited in the loop — parallel calls must not serialise.
            watchers.push(ctx.guard(`subagent[${id}].tool`, () => consumeToolCall(call, ctx, inner, id)));
        }
        await Promise.all(watchers);
    };

    await Promise.all([
        ctx.guard(`subagent[${id}].toolCalls`, drainTools),
        ctx.guard(`subagent[${id}].messages`, () => consumeMessages(sub.messages, ctx, inner, id)),
    ]);

    let status: 'done' | 'failed' = 'done';
    let summary = inner.finalText;
    try {
        const output = await sub.output;
        const text = outputText(output);
        if (text.trim()) summary = text;
    } catch (err) {
        status = 'failed';
        result.errors.push(
            `subagent[${id}]: ${err instanceof Error ? err.message : String(err)}`,
        );
    }

    await ctx.recorder.subagent({
        id, role: sub.name, task, status,
        toolCount: inner.toolsUsed.length,
        tokensIn: inner.inputTokens,
        tokensOut: inner.outputTokens,
        ...(summary ? { summary: summary.slice(0, MAX_SUBAGENT_SUMMARY) } : {}),
    });

    result.toolsUsed.push(...inner.toolsUsed);
    result.modelTurns += inner.modelTurns;
    result.inputTokens += inner.inputTokens;
    result.outputTokens += inner.outputTokens;
}

/**
 * Consume every projection of a deep run into the recorder.
 * Exported for tests — production callers use executeDeepRun / resumeDeepRun.
 */
export async function consumeDeepRun(
    run: DeepProjections,
    recorder: DeepEventRecorder,
    signal: AbortSignal | undefined,
): Promise<DeepConsumeResult> {
    const result = emptyResult();

    if (signal?.aborted) {
        result.aborted = true;
        return result;
    }

    // A failure in one task must not lose the others, so every task carries its own
    // catch that records the error and returns.
    const guard = (label: string, task: () => Promise<void>): Promise<void> =>
        task().catch((err: unknown) => {
            result.errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
        });

    const ctx: ConsumeContext = { recorder, signal, guard };

    const drain = Promise.all([
        guard('messages', () => consumeMessages(run.messages, ctx, result)),

        guard('toolCalls', async () => {
            const watchers: Promise<void>[] = [];
            for await (const call of run.toolCalls) {
                observe(call.output, call.status, call.error);
                if (signal?.aborted) break;
                watchers.push(guard('toolCall', () => consumeToolCall(call, ctx, result)));
            }
            await Promise.all(watchers);
        }),

        guard('subagents', async () => {
            const watchers: Promise<void>[] = [];
            // An explicit counter, not watchers.length: the id must be stable even if
            // the push order ever changes, and two concurrent sub-agents of the same
            // role sharing an id would overwrite each other's rows.
            let n = 0;
            for await (const sub of run.subagents) {
                observe(sub.taskInput, sub.output);
                if (signal?.aborted) break;
                const id = `${sub.name}-${++n}`;
                watchers.push(guard(`subagent[${id}]`, () => consumeSubagent(sub, id, ctx, result)));
            }
            await Promise.all(watchers);
        }),

        guard('values', async () => {
            for await (const values of run.values) {
                if (signal?.aborted) break;
                const todos = values?.todos;
                if (Array.isArray(todos)) await recorder.todos(todos as DeepTodo[]);
            }
        }),
    ]);

    // See PROJECTION_DRAIN_TIMEOUT_MS: a projection whose `for await` never completes
    // (the zero-sub-agent case that actually stranded a run) must not strand this
    // Promise.all forever. On expiry we stop waiting — NOT throw — and settle() runs
    // with whatever `result` already holds; the drain itself keeps running in the
    // background (there is no way to cancel a `for await` from outside) but nothing
    // downstream waits on it any more.
    const outcome = await withTimeout(drain, PROJECTION_DRAIN_TIMEOUT_MS);
    if (outcome === TIMED_OUT) {
        result.errors.push(
            `projection drain timed out after ${PROJECTION_DRAIN_TIMEOUT_MS}ms — one or more ` +
            'projections never completed (e.g. a run with no dispatched sub-agents); settling with what was collected so far.',
        );
    }

    if (signal?.aborted) result.aborted = true;
    return result;
}

// ─── Graph plumbing ──────────────────────────────────────────────────────────

/** What the checkpoint state must look like for hitl.ts to read interrupts from it. */
interface InterruptStateLike {
    tasks?: Array<{
        interrupts?: Array<{
            id?: string;
            value?: { actionRequests?: Array<{ name?: string; args?: Record<string, unknown> }> };
        }>;
    }>;
    config?: { configurable?: { checkpoint_id?: unknown } };
}

/**
 * The slice of the compiled deepagents graph this module uses. LangGraph types
 * `streamEvents` as returning an event stream, not the v3 projection object it
 * actually hands back for `version: 'v3'` — the same gap app/api/chat/route.ts
 * papers over with @ts-ignore. Declared here so the cast happens exactly once.
 */
interface DeepGraphLike {
    streamEvents(input: unknown, config: unknown): Promise<DeepProjections>;
    getState(config: unknown): Promise<InterruptStateLike>;
}

/** Build the graph and the invoke config shared by execute and resume. */
async function prepare(run: AgentOpsRun, recorder: DeepEventRecorder) {
    const tenantId = run.tenantId;
    const maxIterations = await resolveMaxIterations(tenantId);
    const resolvedModel = await resolveRunModel(run.model, tenantId);
    // deriveUserId, NOT a per-run id: agent_memories is keyed (tenantId, userId), so
    // `agent-ops-${runId}` would make every save unrecallable and silently disable
    // long-term memory for every deep run. Same principal id plan mode uses.
    const userId = deriveUserId(run);

    const graphConfig: GraphConfig = {
        model: resolvedModel,
        autoApprove: run.autoApprove ?? false,
        accounts: run.accountId
            ? [{ accountId: run.accountId, accountName: run.accountName || run.accountId }]
            : [],
        accountId: run.accountId,
        accountName: run.accountName,
        selectedSkill: run.selectedSkill ?? null,
        mcpServerIds: run.mcpServerIds,
        knowledgeBaseIds: run.knowledgeBaseIds,
        tenantId,
        userId,
        maxIterations,
        onMemoryEvent: (op, summary) => { void recorder.memory(op, summary); },
    };

    // See DeepGraphLike: LangGraph's streamEvents signature does not describe the
    // v3 projection object, so the compiled graph is narrowed to what we call.
    const graph = await createDeepExecutorGraph(graphConfig) as unknown as DeepGraphLike;

    // tenant_id/user_id MUST be in configurable: execute_command reads
    // config.configurable.tenant_id at invoke time to point
    // AWS_SHARED_CREDENTIALS_FILE at the tenant creds file. Matches the chat route.
    const invokeConfig = {
        version: 'v3' as const,
        // maxIterations and LangGraph's recursionLimit do NOT count the same
        // thing across modes: plan mode counts executor-graph loops (tenants
        // legitimately tune it in the 10-30 range there), but deep counts every
        // individual model/tool/sub-agent step in the deepagents graph — a much
        // finer-grained unit. Using the tenant's plan-tuned value verbatim here
        // starves deep runs, killing them with GraphRecursionError before they
        // accomplish anything. Floor it well above what a real deep run needs;
        // do NOT "simplify" this back to `maxIterations` alone.
        recursionLimit: Math.max(maxIterations, 150),
        configurable: { thread_id: run.threadId, tenant_id: tenantId, user_id: userId },
        context: { tenantId, userId, threadId: run.threadId },
    };

    return { graph, invokeConfig, threadConfig: { configurable: { thread_id: run.threadId } } };
}

/**
 * After the projections drain, decide the run's terminal state: cancelled,
 * awaiting_approval (per-action interrupt), or completed.
 *
 * ask_user interrupts are NOT split out into awaiting_input: they arrive in the same
 * `state.tasks[].interrupts[]` payload as gated tools and resume through the same
 * two-level ResumeMap, so the whole pending set is surfaced as one 'deep_actions'
 * approval and hitl.ts's toResumeMap turns each ask_user into a `respond` decision.
 */
async function settle(
    run: AgentOpsRun,
    graph: DeepGraphLike,
    threadConfig: unknown,
    recorder: DeepEventRecorder,
    result: DeepConsumeResult,
    startedAt: number,
    terminal: TerminalMark,
    eventBus?: GatewayEventBus,
): Promise<void> {
    const { runId, tenantId } = run;

    if (isAborted(runId) || result.aborted) {
        await agentOpsService.updateRunStatus(tenantId, runId, 'cancelled');
        terminal.written = true;
        await recorder.raw({
            eventType: 'final', node: '__cancelled__',
            content: 'Run was cancelled by user.',
            metadata: { durationMs: Date.now() - startedAt },
        });
        eventBus?.emit({ type: 'run:cancelled', runId, tenantId, timestamp: new Date(), data: {} });
        return;
    }

    // See GET_STATE_TIMEOUT_MS: `.catch(() => null)` alone only guards a throw, not a
    // hang — this run's real incident finished the agent cleanly (last event was
    // memory_save) and then stranded at `in_progress` because nothing downstream of
    // it had a bound. Treat a timed-out read as "no interrupt state known" and fall
    // through to the completed path below rather than waiting forever.
    const stateOutcome = await withTimeout(graph.getState(threadConfig).catch(() => null), GET_STATE_TIMEOUT_MS);
    if (stateOutcome === TIMED_OUT) {
        result.errors.push(`getState timed out after ${GET_STATE_TIMEOUT_MS}ms — treating interrupt state as unknown.`);
    }
    const state = stateOutcome === TIMED_OUT ? null : stateOutcome;

    if (state && hasPendingInterrupt(state)) {
        const actions = pendingActions(state);
        const pendingTools = [...new Set(actions.map(a => a.toolName))];
        await recorder.approvalGate(actions);
        await agentOpsService.updateRunStatus(tenantId, runId, 'awaiting_approval', {
            approvalRequest: {
                planSteps: actions.map(a => `${a.toolName}(${JSON.stringify(a.args).slice(0, 200)})`),
                pendingTools,
                approvalType: 'deep_actions',
                pendingActions: actions,
            },
        });
        terminal.written = true;
        eventBus?.emit({
            type: 'hil:tool_approval', runId, tenantId, timestamp: new Date(),
            data: { pendingTools },
        });
        return;
    }

    const durationMs = Date.now() - startedAt;
    const summary = result.finalText || 'Deep agent run completed.';
    const toolsUsed = [...new Set(result.toolsUsed)];

    await agentOpsService.updateRunStatus(tenantId, runId, 'completed', {
        // NOTE: the unit differs from plan mode. Plan mode counts executor graph loops;
        // deep mode has no such loop, so this is MODEL TURNS (memory-middleware turns
        // excluded, sub-agent turns included). Never 0 for a run that called the model.
        result: { summary, toolsUsed, iterations: result.modelTurns },
    });
    terminal.written = true;
    // ONE final row per run. recorder.final owns the seq stamp and the 5000-char cap.
    await recorder.final(summary, {
        durationMs,
        toolsUsed,
        totalInputTokens: result.inputTokens,
        totalOutputTokens: result.outputTokens,
        ...(result.errors.length ? { projectionErrors: result.errors } : {}),
    });

    console.log(`[DeepRunExecutor] ✅ Run ${runId} completed in ${durationMs}ms | ${result.modelTurns} model turn(s) | Tokens: ${result.inputTokens}→${result.outputTokens}${result.errors.length ? ` | ${result.errors.length} projection error(s)` : ''}`);

    const fresh = await agentOpsService.getRun(tenantId, runId);
    eventBus?.emit({ type: 'run:completed', runId, tenantId, timestamp: new Date(), data: { run: fresh ?? run } });
}

/**
 * Set once a run's outcome status has been written. `settle` can still throw AFTER
 * it lands (the getRun refresh, the bus emit, a recorder sink), and without this the
 * catch below would flip a completed/awaiting_approval run to `failed` and append a
 * second terminal row. The error is still recorded — only the status flip is skipped.
 *
 * INVARIANT — `written` means "an outcome status is COMMITTED IN THE DATABASE". It may
 * therefore only be assigned on the line AFTER the `updateRunStatus` that commits it,
 * never before. Setting it first looks equivalent and is not: if that write throws,
 * handleFailure sees the mark, skips the status flip, and the run is stranded at
 * `in_progress` forever — no terminal status, nothing to reconcile it, and it sits in
 * the run list and the scheduled-run digests indefinitely. A run mislabelled `failed`
 * is at least visibly finished; a stranded run never is. Every assignment in this file
 * must stay directly below its own successful write.
 */
interface TerminalMark { written: boolean }

async function handleFailure(
    run: AgentOpsRun,
    error: unknown,
    startedAt: number,
    recorder: DeepEventRecorder,
    terminal: TerminalMark,
    eventBus?: GatewayEventBus,
): Promise<void> {
    const { runId, tenantId } = run;
    const message = error instanceof Error ? error.message : String(error);
    const isAbort = message === 'This operation was aborted'
        || (error instanceof Error && error.name === 'AbortError')
        || isAborted(runId);

    // The run already has its outcome; this threw on the way out. Record it as a
    // diagnostic and leave the status and the terminal row alone.
    if (terminal.written) {
        console.error(`[DeepRunExecutor] ⚠ Run ${runId} threw AFTER its terminal status was written (status preserved):`, message);
        await recorder.raw({
            eventType: 'error', node: 'deep_executor',
            content: message,
            metadata: {
                afterTerminalStatus: true,
                stack: (error instanceof Error ? error.stack : '')?.slice(0, 2000),
            },
        });
        return;
    }

    if (isAbort) {
        console.log(`[DeepRunExecutor] 🛑 Run ${runId} cancelled`);
        await agentOpsService.updateRunStatus(tenantId, runId, 'cancelled');
        terminal.written = true;
        await recorder.raw({
            eventType: 'final', node: '__cancelled__',
            content: 'Run was cancelled by user.',
            metadata: { durationMs: Date.now() - startedAt },
        });
        eventBus?.emit({ type: 'run:cancelled', runId, tenantId, timestamp: new Date(), data: {} });
        return;
    }

    console.error(`[DeepRunExecutor] ❌ Run ${runId} failed:`, message);
    await agentOpsService.updateRunStatus(tenantId, runId, 'failed', { error: message });
    terminal.written = true;
    await recorder.raw({
        eventType: 'error', node: 'deep_executor',
        content: message,
        metadata: { stack: (error instanceof Error ? error.stack : '')?.slice(0, 2000) },
    });
    eventBus?.emit({ type: 'run:failed', runId, tenantId, timestamp: new Date(), data: { error: message } });
}

/** Poll the run's DB status so a cancel issued on another replica still aborts here. */
function startCancelWatchdog(run: AgentOpsRun, abort: AbortController): () => void {
    let stopped = false;
    void (async () => {
        while (!stopped && !abort.signal.aborted) {
            await new Promise(r => setTimeout(r, CANCEL_POLL_INTERVAL_MS));
            if (stopped) return;
            try {
                const fresh = await agentOpsService.getRun(run.tenantId, run.runId);
                if (fresh?.status === 'cancelled') abort.abort();
            } catch { /* never let a status poll kill a healthy run */ }
        }
    })();
    return () => { stopped = true; };
}

/** Shared body of execute/resume: everything but the graph input. */
async function driveDeepRun(
    run: AgentOpsRun,
    buildInput: () => unknown,
    eventBus: GatewayEventBus | undefined,
    onStart: (recorder: DeepEventRecorder) => Promise<void>,
): Promise<void> {
    const { runId, tenantId } = run;
    const startedAt = Date.now();
    const abortController = registerRun(runId);
    const recorder = createDeepEventRecorder({
        runId, tenantId, sink: params => recordAndEmit(eventBus, params),
    });
    const stopWatchdog = startCancelWatchdog(run, abortController);
    const terminal: TerminalMark = { written: false };

    try {
        await agentOpsService.updateRunStatus(tenantId, runId, 'in_progress');
        await onStart(recorder);

        const { graph, invokeConfig, threadConfig } = await prepare(run, recorder);
        const projections = await graph.streamEvents(buildInput(), {
            ...invokeConfig,
            signal: abortController.signal,
        });

        const result = await consumeDeepRun(projections, recorder, abortController.signal);
        await settle(run, graph, threadConfig, recorder, result, startedAt, terminal, eventBus);
    } catch (error) {
        await handleFailure(run, error, startedAt, recorder, terminal, eventBus);
    } finally {
        stopWatchdog();
        cleanupRun(runId);
    }
}

export async function executeDeepRun(run: AgentOpsRun, eventBus?: GatewayEventBus): Promise<void> {
    console.log(`[DeepRunExecutor] ▶ Run ${run.runId} starting (deep)`);
    await driveDeepRun(
        run,
        () => ({ messages: [new HumanMessage(run.taskDescription)] }),
        eventBus,
        recorder => recorder.raw({
            eventType: 'planning', node: '__start__',
            content: `Deep agent run started. Task: ${run.taskDescription}`,
            metadata: { mode: 'deep', accountId: run.accountId, accountName: run.accountName },
        }),
    );
}

export async function resumeDeepRun(
    run: AgentOpsRun,
    resumeMap: ResumeMap,
    eventBus?: GatewayEventBus,
): Promise<void> {
    const count = Object.keys(resumeMap).length;
    console.log(`[DeepRunExecutor] ⏵ Run ${run.runId} resuming with ${count} interrupt(s)`);
    await driveDeepRun(
        run,
        () => new Command({ resume: resumeMap }),
        eventBus,
        recorder => recorder.raw({
            eventType: 'planning', node: '__resume__',
            content: `Resuming deep agent run with decisions for ${count} interrupt(s).`,
            metadata: { mode: 'deep', interruptCount: count },
        }),
    );
}
