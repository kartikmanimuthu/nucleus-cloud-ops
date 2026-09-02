import type { UIMessageChunk } from 'ai';
import type { SubagentEvent } from '@/lib/agent/dispatch-agent-tool';
import {
    buildPlanPart, buildUsagePart, buildSubagentPart, buildActiveSkillPart, buildPhasePart,
    buildMemoryPart, buildHeartbeatChunks, isMemoryNarration,
} from './stream-parts';
import { todosToPlanSteps } from '@/lib/agent/deep/stream-adapt';
import { pendingActions } from '@/lib/agent/deep/hitl';
import type { ToolCallHandle, DeepRun } from '@/lib/agent/deep/projections';

/**
 * Deep-mode stream, built on the documented v3 projections.
 *
 * Consumption follows the event-streaming docs literally:
 *  - each projection is consumed in its own async IIFE inside Promise.all (Example 6)
 *  - per-tool and per-subagent completion is tracked with .then() collected into `watchers`,
 *    never awaited inside the parent loop (Example 2) — parallel work must not serialise
 *  - `message.text` / `.reasoning` are ITERATED for deltas. They are dual-interface: awaiting
 *    resolves the whole message and blocks until it finishes, which is what stalled an earlier
 *    attempt at this.
 *
 * `processStream` (v2) is untouched and still serves fast/plan.
 */

export interface DeepStreamOptions {
    run: DeepRun;
    threadId: string;
    releaseLock: () => void;
    activeSkill?: { slug: string; source: 'user' | 'auto' } | null;
    /** Emitted before the run, for tools decided without executing (rejections, ask_user). */
    syntheticDecisionResults?: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown>; output: string }>;
    onSubagentEvent?: (event: SubagentEvent) => void;
    /** Interrupt state is read after the run finishes; supplied by the route. */
    getInterruptState: () => Promise<unknown>;
    /** Run token totals, for the history metadata the UI reads back on reload. */
    onUsage?: (input: number, output: number) => void;
    /** Memory narration text, so a reloaded thread replays the same memory rows the run streamed. */
    onMemoryText?: (op: 'recall' | 'save', text: string) => void;
    onFinish?: () => Promise<void> | void;
}

function outputText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object' && 'content' in value) {
        const c = (value as { content: unknown }).content;
        return typeof c === 'string' ? c : JSON.stringify(c);
    }
    return JSON.stringify(value ?? '');
}

export function processDeepStream(opts: DeepStreamOptions): ReadableStream<UIMessageChunk> {
    const {
        run, threadId, releaseLock, activeSkill, syntheticDecisionResults = [],
        onSubagentEvent, getInterruptState, onUsage, onMemoryText, onFinish,
    } = opts;

    return new ReadableStream<UIMessageChunk>({
        async start(controller) {
            let closed = false;
            let emittedAnything = false;
            let partCounter = 0;

            // Every line is tagged with its SOURCE, so a UI part can always be traced back to
            // the projection that produced it. grep '[DeepStream]' to see one run end to end.
            const t0 = Date.now();
            const tally = { text: 0, toolCards: 0, toolResults: 0, subagents: 0, plan: 0, approvals: 0, clarifications: 0, synthetic: 0 };
            const log = (source: string, detail: string) =>
                console.log(`[DeepStream][${threadId}] ${source.padEnd(11)} ${detail}`);

            const send = (chunk: UIMessageChunk): boolean => {
                if (closed) return false;
                try {
                    controller.enqueue(chunk);
                    return true;
                } catch {
                    closed = true;
                    return false;
                }
            };

            // CloudFront drops any origin connection idle for 60s
            // (originReadTimeout, infra/compute/index.ts). A sub-agent thinks and runs
            // tools for minutes while this stream emits nothing, so the browser saw
            // "network error" and the abort surfaced here as
            // "task callId=... -> ERROR This operation was aborted" — reproducible on
            // sbx, never locally, because localhost has no CloudFront in front of it.
            //
            // processStream (v2) has carried this heartbeat since fast/plan gained
            // sub-agents; the v3 deep path never got it. Same 15s tick, same pure
            // buildHeartbeatChunks body, which always yields at least one chunk:
            // liveSubagents empties as sub-agents finish, and the orchestrator's
            // post-fan-out call is the longest silence in the run, so a map-dependent
            // tick would go quiet exactly when the timeout bites. The fallback chunk is
            // `transient`, so deriveRunState never sees it and no UI state moves.
            // Nothing may be inserted between this setInterval and the `try` — the
            // matching clearInterval lives in that try's finally.
            const liveSubagents = new Map<string, SubagentEvent>();
            const HEARTBEAT_MS = 15_000;
            const heartbeat = setInterval(() => {
                for (const chunk of buildHeartbeatChunks(liveSubagents.values())) send(chunk);
            }, HEARTBEAT_MS);

            try {
                log('run', `start${activeSkill ? ` skill=${activeSkill.slug}(${activeSkill.source})` : ''}`);
                send({ type: 'start' });
                if (activeSkill) send(buildActiveSkillPart(activeSkill.slug, activeSkill.source) as UIMessageChunk);

                // Decisions that never execute produce no tool events, so mirror them here or
                // their cards hang. Ids are the ones the pre-pause parts already use.
                for (const s of syntheticDecisionResults) {
                    send({ type: 'tool-input-start', toolCallId: s.toolCallId, toolName: s.toolName });
                    send({ type: 'tool-input-available', toolCallId: s.toolCallId, toolName: s.toolName, input: s.args });
                    send({ type: 'tool-output-available', toolCallId: s.toolCallId, output: s.output });
                    tally.synthetic++;
                    log('decision', `${s.toolName} id=${s.toolCallId} (decided, never executed)`);
                    emittedAnything = true;
                }

                // Completion watchers for parallel work — never awaited inside a parent loop.
                const watchers: Promise<unknown>[] = [];

                const watchToolCall = (call: ToolCallHandle, source = 'toolCalls') => {
                    // Observe both promises immediately. On Stop they reject, and whichever branch
                    // below does not read one would leave its rejection unobserved — Node treats an
                    // unhandled rejection as fatal by default (>= v15). Measured: 3 aborted `task`
                    // calls produced exactly 3 `unhandledRejection: AbortError`.
                    void Promise.resolve(call.output).catch(() => undefined);
                    void Promise.resolve(call.error).catch(() => undefined);

                    // callId "correlates with protocol toolCallId", so input and output pair by
                    // construction. No run_id bookkeeping, no per-branch id invention.
                    send({ type: 'tool-input-start', toolCallId: call.callId, toolName: call.name });
                    send({
                        type: 'tool-input-available',
                        toolCallId: call.callId,
                        toolName: call.name,
                        input: (call.input ?? {}) as Record<string, unknown>,
                    });
                    emittedAnything = true;
                    tally.toolCards++;
                    log(source, `${call.name} callId=${call.callId} -> card opened`);

                    watchers.push(
                        Promise.resolve(call.status).then(async status => {
                            tally.toolResults++;
                            if (status === 'finished') {
                                // `task` resolves to a LangGraph Command — framework internals
                                // ({"lg_name":"Command","update":{...}}) that meant nothing in the
                                // transcript. The sub-agent card already carries the real result,
                                // so the card just needs a short line to close on.
                                const output = call.name === 'task'
                                    ? `Delegated to ${String((call.input as { subagent_type?: unknown })?.subagent_type ?? 'sub-agent')} — see the sub-agent card for its findings.`
                                    : outputText(await call.output);
                                send({ type: 'tool-output-available', toolCallId: call.callId, output });
                                log(source, `${call.name} callId=${call.callId} -> finished`);
                            } else if (status === 'error') {
                                const err = await call.error;
                                send({ type: 'tool-output-available', toolCallId: call.callId, output: `Error: ${err ?? 'tool failed'}` });
                                log(source, `${call.name} callId=${call.callId} -> ERROR ${String(err).slice(0, 80)}`);
                            } else {
                                log(source, `${call.name} callId=${call.callId} -> ${status} (no output part)`);
                            }
                        }).catch(() => undefined),
                    );
                };

                await Promise.all([
                    // --- text + usage ---------------------------------------------------------
                    // The per-message consumer is LAUNCHED, never awaited here (docs Example 6).
                    // Blocking this loop on message.text deadlocks the run after the first model
                    // call — measured: 2 of 3 runs stalled at 2 messages before this change.
                    (async () => {
                        for await (const message of run.messages) {
                            const node = message.node ?? 'model_request';
                            const isMemoryRecall = node.startsWith('DeepMemoryMiddleware.before');
                            const isMemorySave = node.startsWith('DeepMemoryMiddleware.after');
                            const isMemoryPhase = isMemoryRecall || isMemorySave;

                            log('messages', `handle #${++partCounter} node=${node}${isMemoryPhase ? ' (memory)' : ''}`);

                            if (isMemoryPhase) {
                                const phase = isMemorySave ? 'memory_save' : 'memory_recall';
                                send(buildPhasePart(phase, node) as UIMessageChunk);
                                watchers.push((async () => {
                                    let buf = '';
                                    for await (const delta of message.text) {
                                        if (delta) buf += delta;
                                    }
                                    if (buf.trim() && isMemoryNarration(buf)) {
                                        const op = isMemorySave ? 'save' : 'recall';
                                        send(buildMemoryPart(op, buf) as UIMessageChunk);
                                        onMemoryText?.(op, buf);
                                        emittedAnything = true;
                                    } else if (buf.trim()) {
                                        log('messages', `memory buffer suppressed (judge/distiller payload, ${buf.length} chars)`);
                                    }
                                })().catch(() => undefined));
                                watchers.push(
                                    Promise.resolve(message.usage).then(u => {
                                        const inTok = Number(u?.input_tokens) || 0;
                                        const outTok = Number(u?.output_tokens) || 0;
                                        if (inTok || outTok) {
                                            onUsage?.(inTok, outTok);
                                            send(buildUsagePart(inTok, outTok) as UIMessageChunk);
                                        }
                                    }).catch(() => undefined),
                                );
                                continue;
                            }

                            const id = `text-${threadId}-${partCounter}`;
                            // The rail reads the LAST data-phase part, so the run must leave a
                            // truthful one behind: 'execution' while working, 'text' (= Idle) at
                            // the end. Emitting only 'planning' pinned the header on Plan forever.
                            send(buildPhasePart('execution', node) as UIMessageChunk);
                            watchers.push((async () => {
                                let opened = false;
                                for await (const delta of message.text) {
                                    if (!delta) continue;
                                    if (!opened) { opened = true; emittedAnything = true; send({ type: 'text-start', id }); }
                                    if (!send({ type: 'text-delta', id, delta })) break;
                                }
                                if (opened) { send({ type: 'text-end', id }); tally.text++; log('messages', `text part ${id} closed`); }
                            })().catch(() => undefined));

                            watchers.push(
                                Promise.resolve(message.usage).then(u => {
                                    const inTok = Number(u?.input_tokens) || 0;
                                    const outTok = Number(u?.output_tokens) || 0;
                                    if (inTok || outTok) {
                                        onUsage?.(inTok, outTok);
                                        send(buildUsagePart(inTok, outTok) as UIMessageChunk);
                                    }
                                }).catch(() => undefined),
                            );
                        }
                    })(),

                    // --- coordinator tool cards ---------------------------------------------
                    (async () => {
                        for await (const call of run.toolCalls) watchToolCall(call);
                    })(),

                    // --- subagent cards ------------------------------------------------------
                    (async () => {
                        let n = 0;
                        for await (const subagent of run.subagents) {
                            // `t0` scopes the id to THIS run. With a bare per-run counter the ids
                            // repeated across runs on the same thread: a second run's card #1 reused
                            // the first run's id, so cards that had finished (or failed on Stop)
                            // flipped back to "running", and the agent_subagent_runs row for the
                            // earlier run was overwritten by the later one.
                            const id = `sub-${threadId}-${t0}-${++n}`;
                            const event: SubagentEvent = {
                                id, role: subagent.name, task: '', status: 'running',
                                toolCount: 0, tokensIn: 0, tokensOut: 0,
                            };
                            liveSubagents.set(id, event);
                            onSubagentEvent?.(event);
                            send(buildSubagentPart(event) as UIMessageChunk);
                            emittedAnything = true;
                            tally.subagents++;
                            log('subagents', `${subagent.name} id=${id} -> running`);

                            // A subagent's own model turns carry its usage; without this the card
                            // reported "0 tokens" for every subagent. Usage is collected through
                            // `watchers` rather than awaited in the loop — awaiting a per-message
                            // handle inside its own iterator is what deadlocked the parent stream.
                            void (async () => {
                                for await (const message of subagent.messages) {
                                    watchers.push(
                                        Promise.resolve(message.usage).then(u => {
                                            const inTok = Number(u?.input_tokens) || 0;
                                            const outTok = Number(u?.output_tokens) || 0;
                                            if (!inTok && !outTok) return;
                                            event.tokensIn += inTok;
                                            event.tokensOut += outTok;
                                            onSubagentEvent?.({ ...event });
                                            send(buildSubagentPart({ ...event }) as UIMessageChunk);
                                        }).catch(() => undefined),
                                    );
                                }
                            })().catch(() => undefined);

                            // Nested consumers are launched, never awaited here (docs Example 6).
                            // The .catch is not optional: on Stop these iterators reject, and an
                            // uncaught rejection here surfaced as `unhandledRejection: AbortError`
                            // — which terminates a Node process by default (>= v15).
                            void (async () => {
                                for await (const call of subagent.toolCalls) {
                                    event.toolCount += 1;
                                    event.lastTool = call.name;
                                    onSubagentEvent?.({ ...event });
                                    send(buildSubagentPart({ ...event }) as UIMessageChunk);
                                    log('subagents', `${subagent.name} tool#${event.toolCount} ${call.name}`);
                                }
                            })().catch(() => undefined);

                            watchers.push(
                                Promise.resolve(subagent.taskInput)
                                    .then(t => { event.task = typeof t === 'string' ? t : JSON.stringify(t ?? ''); })
                                    .catch(() => undefined),
                            );
                            watchers.push(
                                Promise.resolve(subagent.output).then(
                                    out => {
                                        const done: SubagentEvent = { ...event, status: 'done', summary: outputText(out).slice(0, 4000) };
                                        liveSubagents.delete(id);
                                        onSubagentEvent?.(done);
                                        send(buildSubagentPart(done) as UIMessageChunk);
                                        log('subagents', `${subagent.name} id=${id} -> done (${event.toolCount} tools)`);
                                    },
                                    () => {
                                        const failed: SubagentEvent = { ...event, status: 'failed' };
                                        liveSubagents.delete(id);
                                        onSubagentEvent?.(failed);
                                        send(buildSubagentPart(failed) as UIMessageChunk);
                                        log('subagents', `${subagent.name} id=${id} -> FAILED`);
                                    },
                                ),
                            );
                        }
                    })(),

                    // --- plan rail from todos -------------------------------------------------
                    (async () => {
                        let last = '';
                        for await (const values of run.values) {
                            const todos = values?.todos as Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }> | undefined;
                            if (!Array.isArray(todos) || todos.length === 0) continue;
                            const key = JSON.stringify(todos);
                            if (key === last) continue;
                            last = key;
                            send(buildPlanPart(threadId, todosToPlanSteps(todos), 'deep') as UIMessageChunk);
                            send(buildPhasePart('planning', 'deep_todos') as UIMessageChunk);
                            tally.plan++;
                            log('values', `todos -> plan rail (${todos.length} steps, ${todos.filter(t => t.status === 'completed').length} done)`);
                        }
                    })(),
                ]);

                await Promise.allSettled(watchers);

                // --- approvals / clarifications ---------------------------------------------
                // Read from state, NOT run.interrupts: measured, run.interrupts yields payloads
                // with id=undefined and actionRequests=0, while state.tasks[].interrupts carries
                // the real id and actionRequests. This is also the path that surfaces SUBAGENT
                // interrupts — the parent's own message only shows `task`.
                const state = await getInterruptState();
                const pending = pendingActions(state as never);
                log('interrupts', `state.tasks[].interrupts -> ${pending.length} pending action(s)`);
                if (pending.length > 0) {
                    const approvalTools: unknown[] = [];
                    const clarifications: UIMessageChunk[] = [];
                    for (const action of pending) {
                        if (action.toolName === 'ask_user') {
                            clarifications.push({
                                type: 'data-clarification',
                                id: `clarify-${action.toolCallId}`,
                                data: {
                                    toolCallId: action.toolCallId,
                                    question: String(action.args.question ?? 'The agent needs your input.'),
                                    options: Array.isArray(action.args.options) ? action.args.options.map(String) : [],
                                },
                            } as unknown as UIMessageChunk);
                        } else {
                            approvalTools.push({
                                toolCallId: action.toolCallId,
                                toolName: action.toolName,
                                args: action.args,
                                guard: null,
                            });
                        }
                    }
                    // Order matters: deriveRunState resets stale clarifications when a
                    // data-approval arrives, so approval precedes clarifications from the
                    // SAME interrupt — and is emitted even when empty.
                    send({
                        type: 'data-approval',
                        id: `approval-${threadId}`,
                        data: { batchId: `batch-${threadId}-${Date.now()}`, tools: approvalTools },
                    } as unknown as UIMessageChunk);
                    for (const part of clarifications) send(part);
                    tally.approvals += approvalTools.length;
                    tally.clarifications += clarifications.length;
                    for (const a of pending) log('interrupts', `awaiting ${a.toolName} id=${a.toolCallId}`);
                    emittedAnything = true;
                }

                // The AI SDK requires a message to carry text or a pending tool call.
                if (!emittedAnything) {
                    const id = `empty-${threadId}`;
                    send({ type: 'text-start', id });
                    send({ type: 'text-delta', id, delta: ' ' });
                    send({ type: 'text-end', id });
                }

                send(buildPhasePart('text', 'deep_done') as UIMessageChunk);
                log('run', `finish in ${Date.now() - t0}ms | ${Object.entries(tally).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(' ') || 'nothing emitted'}`);
                send({ type: 'finish' });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const aborted = message.includes('Abort') || (error as { name?: string })?.name === 'AbortError';
                log('run', `${aborted ? 'aborted' : 'ERROR'} after ${Date.now() - t0}ms`);
                if (!aborted) {
                    console.error('[DeepStream] error:', error);
                    send({ type: 'error', errorText: message } as unknown as UIMessageChunk);
                }
            } finally {
                clearInterval(heartbeat);
                try { await onFinish?.(); } catch (e) { console.error('[DeepStream] onFinish failed:', e); }
                releaseLock();
                if (!closed) { closed = true; try { controller.close(); } catch { /* already closed */ } }
            }
        },
    });
}
