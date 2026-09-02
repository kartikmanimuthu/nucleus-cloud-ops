import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { consumeDeepRun, PROJECTION_DRAIN_TIMEOUT_MS } from './deep-run-executor';
import { createDeepEventRecorder } from './deep-event-recorder';
import type { RecordEventParams } from './record-and-emit';
import type { ToolCallStatus, SubagentHandle, DeepProjections } from '@/lib/agent/deep/projections';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveUserId } from './agent-executor';
import type { AgentOpsRun } from './types';

/** Async iterable from a fixed list. */
async function* iter<T>(items: T[]): AsyncIterable<T> {
    for (const i of items) yield i;
}

function textStream(chunks: string[]) {
    return { async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; } };
}

function message(text: string[], reasoning: string[] = []) {
    return {
        node: 'call_model',
        text: textStream(text),
        reasoning: textStream(reasoning),
        usage: Promise.resolve({ input_tokens: 10, output_tokens: 5 }),
    };
}

/** A DeepMemoryMiddleware turn — same handle shape, a middleware node name. */
function memoryMessage(node: string, text: string) {
    return { ...message([text]), node };
}

/**
 * An async iterable whose iterator never resolves `next()` and never returns —
 * models the real production hang (a projection, e.g. `subagents` when the model
 * dispatches zero sub-agents, whose `for await` never completes).
 */
function hangingIterable<T>(): AsyncIterable<T> {
    return {
        [Symbol.asyncIterator]() {
            return { next: () => new Promise<IteratorResult<T>>(() => { }) };
        },
    };
}

function toolCall(name: string, callId: string, output: unknown, status: ToolCallStatus = 'finished') {
    return {
        name, callId, input: { a: 1 },
        output: Promise.resolve(output),
        status: Promise.resolve(status),
        error: Promise.resolve(undefined),
    };
}

function harness() {
    const sink = vi.fn<(params: RecordEventParams) => Promise<void>>().mockResolvedValue(undefined);
    const recorder = createDeepEventRecorder({ runId: 'r1', tenantId: 't1', sink });
    return { sink, recorder, rows: () => sink.mock.calls.map(c => c[0]) };
}

describe('consumeDeepRun', () => {
    beforeEach(() => vi.clearAllMocks());
    afterEach(() => vi.useRealTimers());

    it('records accumulated assistant text', async () => {
        const { recorder, rows } = harness();
        const run = {
            messages: iter([message(['Hello ', 'world'])]),
            toolCalls: iter([]),
            subagents: iter([]),
            values: iter([]),
        };
        const result = await consumeDeepRun(run, recorder, undefined);
        const texts = rows().filter(r => r.eventType === 'execution').map(r => r.content);
        expect(texts.join('')).toContain('Hello world');
        expect(result.finalText).toContain('Hello world');
    });

    it('writes exactly one text row per message, not one per streamed chunk', async () => {
        const { recorder, rows } = harness();
        const run = {
            // Five separate chunks — the real run measured 1,027 rows this way,
            // avg 4 chars / max 16, one per streamed token.
            messages: iter([message(['We', ' need', ' to', '**', ' investigate'])]),
            toolCalls: iter([]), subagents: iter([]), values: iter([]),
        };
        await consumeDeepRun(run, recorder, undefined);
        const textRows = rows().filter(r => r.eventType === 'execution' && !r.metadata?.reasoning);
        expect(textRows).toHaveLength(1);
        expect(textRows[0].content).toBe('We need to** investigate');
    });

    it('records reasoning separately', async () => {
        const { recorder, rows } = harness();
        const run = {
            messages: iter([message([], ['pondering'])]),
            toolCalls: iter([]), subagents: iter([]), values: iter([]),
        };
        await consumeDeepRun(run, recorder, undefined);
        expect(rows().some(r => r.metadata?.reasoning === true)).toBe(true);
    });

    it('records a tool call and its result, and collects the tool name', async () => {
        const { recorder, rows } = harness();
        const run = {
            messages: iter([]),
            toolCalls: iter([toolCall('execute_command', 'c1', 'ok')]),
            subagents: iter([]), values: iter([]),
        };
        const result = await consumeDeepRun(run, recorder, undefined);
        expect(rows().some(r => r.eventType === 'tool_call' && r.toolName === 'execute_command')).toBe(true);
        expect(rows().some(r => r.eventType === 'tool_result' && r.toolOutput === 'ok')).toBe(true);
        expect(result.toolsUsed).toContain('execute_command');
    });

    it('marks an errored tool result', async () => {
        const { recorder, rows } = harness();
        const run = {
            messages: iter([]),
            toolCalls: iter([toolCall('execute_command', 'c1', 'boom', 'error')]),
            subagents: iter([]), values: iter([]),
        };
        await consumeDeepRun(run, recorder, undefined);
        const res = rows().find(r => r.eventType === 'tool_result');
        expect(res?.metadata?.status).toBe('error');
    });

    it('records todos from the values projection', async () => {
        const { recorder, rows } = harness();
        const run = {
            messages: iter([]), toolCalls: iter([]), subagents: iter([]),
            values: iter([{ todos: [{ content: 'one', status: 'pending' }] }]),
        };
        await consumeDeepRun(run, recorder, undefined);
        expect(rows().some(r => r.eventType === 'todo')).toBe(true);
    });

    it('tags sub-agent tool calls with the sub-agent id', async () => {
        const { recorder, rows } = harness();
        const sub = {
            name: 'aws-ops',
            taskInput: Promise.resolve('list buckets'),
            output: Promise.resolve('done'),
            toolCalls: iter([toolCall('execute_command', 'sc1', 'bucket-a')]),
            messages: iter([message(['sub thinking'])]),
        };
        const run = { messages: iter([]), toolCalls: iter([]), subagents: iter([sub]), values: iter([]) };
        const result = await consumeDeepRun(run, recorder, undefined);
        const tagged = rows().filter(r => typeof r.metadata?.subagentId === 'string');
        expect(tagged.length).toBeGreaterThan(0);
        expect(rows().some(r => r.eventType === 'subagent')).toBe(true);
        // The sub-agent's tools roll up into the run's tool list.
        expect(result.toolsUsed).toContain('execute_command');
    });

    it('gives every row a unique increasing seq even with concurrent producers', async () => {
        const { recorder, rows } = harness();
        const run = {
            messages: iter([message(['a']), message(['b'])]),
            toolCalls: iter([toolCall('t1', 'c1', 'x'), toolCall('t2', 'c2', 'y')]),
            subagents: iter([]),
            values: iter([{ todos: [{ content: 'z', status: 'pending' }] }]),
        };
        await consumeDeepRun(run, recorder, undefined);
        const seqs = rows().map(r => r.metadata?.seq as number);
        expect(new Set(seqs).size).toBe(seqs.length);
        expect([...seqs].sort((x, y) => x - y)).toEqual(seqs);
    });

    it('stops early when the signal is already aborted', async () => {
        const { recorder, sink } = harness();
        const ac = new AbortController();
        ac.abort();
        const run = {
            messages: iter([message(['should not appear'])]),
            toolCalls: iter([]), subagents: iter([]), values: iter([]),
        };
        const result = await consumeDeepRun(run, recorder, ac.signal);
        expect(result.aborted).toBe(true);
        expect(sink).not.toHaveBeenCalled();
    });

    it('survives a projection that throws without losing the others', async () => {
        const { recorder, rows } = harness();
        const exploding = { async *[Symbol.asyncIterator]() { throw new Error('projection died'); } };
        const run = {
            messages: iter([message(['still recorded'])]),
            toolCalls: exploding,
            subagents: iter([]), values: iter([]),
        };
        const result = await consumeDeepRun(run, recorder, undefined);
        expect(rows().some(r => r.content?.includes('still recorded'))).toBe(true);
        expect(result.errors.length).toBeGreaterThan(0);
    });

    // ─── Timeout bound on the drain (Defect B) ────────────────────────────────
    // The real incident: the model dispatched zero sub-agents, `run.subagents`'s
    // `for await` never completed, and the surrounding Promise.all — the whole
    // run — hung at 0% CPU forever. Nothing here may await real wall-clock time.

    it('a run with zero dispatched sub-agents still terminates', async () => {
        vi.useFakeTimers();
        const { recorder, rows } = harness();
        const run: DeepProjections = {
            messages: iter([message(['done'])]),
            toolCalls: iter([]),
            // The exact production failure: the model dispatched no sub-agents, and
            // the projection representing that never signalled completion.
            subagents: hangingIterable<SubagentHandle>(),
            values: iter([]),
        };

        const pending = consumeDeepRun(run, recorder, undefined);
        await vi.advanceTimersByTimeAsync(PROJECTION_DRAIN_TIMEOUT_MS + 1);
        const result = await pending;

        expect(result.errors.some(e => /timed out/i.test(e))).toBe(true);
        // The other three projections still ran to completion and got recorded —
        // one hung projection must not lose everything else's rows.
        expect(rows().some(r => r.content?.includes('done'))).toBe(true);
    });

    it('a never-terminating projection does not hang the whole drain', async () => {
        vi.useFakeTimers();
        const { recorder } = harness();
        const run: DeepProjections = {
            messages: iter([]),
            toolCalls: iter([]),
            subagents: iter([]),
            // Neither yields nor returns — any of the four projections could do this
            // in production; the bound must not be specific to `subagents`.
            values: hangingIterable<Record<string, unknown>>(),
        };

        const pending = consumeDeepRun(run, recorder, undefined);
        await vi.advanceTimersByTimeAsync(PROJECTION_DRAIN_TIMEOUT_MS + 1);
        const result = await pending;

        expect(result.errors.some(e => /timed out/i.test(e))).toBe(true);
    });

    // ─── Parallelism ──────────────────────────────────────────────────────────
    // These are the reason this module exists: a projection consumed inline, or a
    // per-item handle awaited inside its own loop, serialises the run. Both are
    // observable — a serialised consumer cannot interleave.

    it('consumes the four projections concurrently, not one after another', async () => {
        const { recorder } = harness();
        const order: string[] = [];

        /** Yields one item, parks on a gate, then yields a second. */
        function gated<T>(label: string, first: T, second: T, gate: Promise<void>): AsyncIterable<T> {
            return {
                async *[Symbol.asyncIterator]() {
                    order.push(`${label}:1`);
                    yield first;
                    await gate;
                    order.push(`${label}:2`);
                    yield second;
                },
            };
        }

        let openGate = () => { };
        const gate = new Promise<void>(resolve => { openGate = resolve; });

        const run = {
            // messages parks on the gate after its first handle...
            messages: gated('messages', message(['one']), message(['two']), gate),
            // ...and toolCalls must still be entered while messages is parked.
            toolCalls: {
                async *[Symbol.asyncIterator]() {
                    order.push('toolCalls:1');
                    // Only reachable if this projection runs while messages is blocked.
                    openGate();
                    yield toolCall('t1', 'c1', 'x');
                },
            },
            subagents: iter([]),
            values: iter([]),
        };

        await consumeDeepRun(run, recorder, undefined);

        // A serialised consumer would deadlock (the gate is only opened by toolCalls),
        // so simply completing proves concurrency. The interleave makes it explicit.
        expect(order.indexOf('toolCalls:1')).toBeLessThan(order.indexOf('messages:2'));
    });

    it('does not serialise parallel tool calls — every call is opened before any result', async () => {
        const { recorder, rows } = harness();
        const later = <T>(value: T, ms: number) =>
            new Promise<T>(resolve => setTimeout(() => resolve(value), ms));

        const slow = {
            name: 'slow', callId: 'c-slow', input: {},
            output: later<unknown>('slow-done', 25),
            status: later<ToolCallStatus>('finished', 25),
            error: Promise.resolve(undefined),
        };
        const fast = toolCall('fast', 'c-fast', 'fast-done');

        const run = {
            messages: iter([]),
            toolCalls: iter([slow, fast]),
            subagents: iter([]), values: iter([]),
        };

        await consumeDeepRun(run, recorder, undefined);

        // Serialised consumption (awaiting each call inside the loop) yields
        // call/result/call/result. Parallel consumption opens both cards first, then
        // lets the results land in completion order — fast before slow.
        const kinds = rows().map(r => `${r.eventType}:${r.toolName}`);
        const lastCall = Math.max(kinds.indexOf('tool_call:slow'), kinds.indexOf('tool_call:fast'));
        const firstResult = Math.min(
            kinds.indexOf('tool_result:slow'),
            kinds.indexOf('tool_result:fast'),
        );
        expect(lastCall).toBeLessThan(firstResult);
        expect(kinds.indexOf('tool_result:fast')).toBeLessThan(kinds.indexOf('tool_result:slow'));
    });

    it('does not await a message whole — text and reasoning are iterated together', async () => {
        const { recorder } = harness();
        let releaseText = () => { };
        const textGate = new Promise<void>(resolve => { releaseText = resolve; });

        const msg = {
            node: 'call_model',
            text: {
                async *[Symbol.asyncIterator]() {
                    yield 'before ';
                    await textGate;   // only reasoning can open this
                    yield 'after';
                },
            },
            reasoning: {
                async *[Symbol.asyncIterator]() {
                    releaseText();
                    yield 'thinking';
                },
            },
            usage: Promise.resolve({ input_tokens: 1, output_tokens: 1 }),
        };

        const run = {
            messages: iter([msg]),
            toolCalls: iter([]), subagents: iter([]), values: iter([]),
        };

        // If text were drained to completion before reasoning started, this deadlocks.
        const result = await consumeDeepRun(run, recorder, undefined);
        expect(result.finalText).toBe('before after');
    });

    it('runs sub-agents in parallel with each other', async () => {
        const { recorder, rows } = harness();

        const slow = {
            name: 'sub-slow',
            taskInput: Promise.resolve('a'),
            output: new Promise<string>(resolve => setTimeout(() => resolve('a-done'), 25)),
            toolCalls: iter([]),
            messages: iter([]),
        };
        const quick = {
            name: 'sub-quick',
            taskInput: Promise.resolve('b'),
            output: Promise.resolve('b-done'),
            toolCalls: iter([]),
            messages: iter([]),
        };

        const run = {
            messages: iter([]), toolCalls: iter([]),
            subagents: iter([slow, quick]),
            values: iter([]),
        };

        await consumeDeepRun(run, recorder, undefined);

        // Serialised sub-agent consumption yields running/done/running/done. Parallel
        // consumption starts both before either finishes, and the quick one finishes first.
        const trail = rows()
            .filter(r => r.eventType === 'subagent')
            .map(r => `${r.metadata?.status}:${r.metadata?.name}`);
        expect(trail).toEqual([
            'running:sub-slow', 'running:sub-quick', 'done:sub-quick', 'done:sub-slow',
        ]);
    });

    it('numbers same-role sub-agents 1..n by ARRIVAL order', async () => {
        const { recorder, rows } = harness();
        // Distinct ids alone is too weak an assertion: it also holds for an id built
        // from `watchers.length`. Pinning the exact 1-based sequence discriminates,
        // and it is the id contract the timeline will render.
        const mk = (settle: () => Promise<string>) => ({
            name: 'aws-ops',
            taskInput: Promise.resolve('t'),
            output: settle(),
            toolCalls: iter([]),
            messages: iter([]),
        });
        const run = {
            messages: iter([]), toolCalls: iter([]),
            subagents: iter([
                // The first to ARRIVE is the last to FINISH — ids must not follow completion.
                mk(() => new Promise(r => setTimeout(() => r('slow'), 25))),
                mk(() => Promise.resolve('quick')),
                mk(() => Promise.resolve('quick')),
            ]),
            values: iter([]),
        };
        await consumeDeepRun(run, recorder, undefined);

        const running = rows()
            .filter(r => r.eventType === 'subagent' && r.metadata?.status === 'running')
            .map(r => String(r.metadata?.subagentId));
        expect(running).toEqual(['aws-ops-1', 'aws-ops-2', 'aws-ops-3']);
        // ...and the slow one, which arrived first, closes last under its arrival id.
        const done = rows()
            .filter(r => r.eventType === 'subagent' && r.metadata?.status === 'done')
            .map(r => String(r.metadata?.subagentId));
        expect(done[done.length - 1]).toBe('aws-ops-1');
    });

    // ─── Memory-middleware turns are not agent output (C1) ────────────────────

    it('never lets a memory-middleware turn become the run summary', async () => {
        const { recorder, rows } = harness();
        const run = {
            // afterAgent runs AFTER the agent's last turn, so the save handle is last —
            // a naive "last non-empty text" would make the distiller the summary.
            messages: iter([
                message(['the real answer']),
                memoryMessage('DeepMemoryMiddleware.afterAgent', 'distilled 3 facts, 1 rule'),
            ]),
            toolCalls: iter([]), subagents: iter([]), values: iter([]),
        };
        const result = await consumeDeepRun(run, recorder, undefined);

        expect(result.finalText).toBe('the real answer');
        expect(result.finalText).not.toContain('distilled');
        // No execution row either — the onMemoryEvent sink already writes memory rows.
        const execText = rows().filter(r => r.eventType === 'execution').map(r => r.content).join('');
        expect(execText).toContain('the real answer');
        expect(execText).not.toContain('distilled');
        expect(rows().some(r => r.content?.includes('distilled'))).toBe(false);
    });

    it('excludes memory turns from the model-turn count but still bills their tokens', async () => {
        const { recorder } = harness();
        const run = {
            messages: iter([
                memoryMessage('DeepMemoryMiddleware.beforeAgent', 'recalled 2 facts'),
                message(['working']),
                memoryMessage('DeepMemoryMiddleware.afterAgent', 'saved 1 rule'),
            ]),
            toolCalls: iter([]), subagents: iter([]), values: iter([]),
        };
        const result = await consumeDeepRun(run, recorder, undefined);

        expect(result.modelTurns).toBe(1);
        // All three handles report 10/5; memory turns cost real money, so they count.
        expect(result.inputTokens).toBe(30);
        expect(result.outputTokens).toBe(15);
    });

    it('counts model turns across the coordinator and its sub-agents', async () => {
        const { recorder } = harness();
        const sub = {
            name: 'aws-ops',
            taskInput: Promise.resolve('t'),
            output: Promise.resolve('done'),
            toolCalls: iter([]),
            messages: iter([message(['a']), message(['b'])]),
        };
        const run = {
            messages: iter([message(['coordinator'])]),
            toolCalls: iter([]),
            subagents: iter([sub]),
            values: iter([]),
        };
        const result = await consumeDeepRun(run, recorder, undefined);
        expect(result.modelTurns).toBe(3);
    });
});

// ─── Memory identity (I1) ─────────────────────────────────────────────────────
// agent_memories is keyed (tenantId, userId). A per-run userId makes every save
// unrecallable, which disables long-term memory SILENTLY — no error, no empty
// result, just a feature that never works. These pin the id to the principal.

describe('deep run memory identity', () => {
    const base = (over: Partial<AgentOpsRun>): AgentOpsRun => ({
        runId: 'run-abc', tenantId: 'tenant-1', source: 'api', status: 'queued',
        taskDescription: 't', mode: 'deep', threadId: 'th-1',
        trigger: {}, createdAt: '', updatedAt: '', ttl: 0,
        PK: '', SK: '', GSI1PK: '', GSI1SK: '',
        ...over,
    } as AgentOpsRun);

    it('derives the userId from the trigger, never from the runId', () => {
        const cases: Array<[Partial<AgentOpsRun>, string]> = [
            [{ source: 'slack', trigger: { userId: 'U123' } as AgentOpsRun['trigger'] }, 'slack-U123'],
            [{ source: 'jira', trigger: { reporter: 'jsmith' } as AgentOpsRun['trigger'] }, 'jira-jsmith'],
            [{ source: 'api', trigger: { clientId: 'cli-9' } as AgentOpsRun['trigger'] }, 'api-cli-9'],
            [{ source: 'scheduled', trigger: { taskId: 'task-7' } as AgentOpsRun['trigger'] }, 'scheduled-task-7'],
            [{ source: 'webhook', trigger: {} as AgentOpsRun['trigger'] }, 'tenant-tenant-1'],
        ];
        for (const [over, expected] of cases) {
            const id = deriveUserId(base(over));
            expect(id).toBe(expected);
            expect(id).not.toContain('run-abc');
        }
    });

    it('gives two runs from the same principal the SAME id', () => {
        const trigger = { userId: 'U123' } as AgentOpsRun['trigger'];
        const first = deriveUserId(base({ runId: 'run-1', source: 'slack', trigger }));
        const second = deriveUserId(base({ runId: 'run-2', source: 'slack', trigger }));
        expect(first).toBe(second);
    });

    it('does not reintroduce a run-scoped userId in the executor', () => {
        // `prepare()` is not exported, and reaching it needs a whole graph mock. This
        // guards the one line that regresses silently: `agent-ops-${run.runId}`.
        const src = readFileSync(join(__dirname, 'deep-run-executor.ts'), 'utf8');
        expect(src).toContain('deriveUserId(run)');
        expect(src).not.toMatch(/userId\s*=\s*`agent-ops-/);
    });
});

// ─── Terminal-status bookkeeping (item 6) ─────────────────────────────────────

describe('terminal status marking', () => {
    it('only marks a run terminal AFTER the status write that commits it', () => {
        // Not behavioural — settle()/handleFailure() need agentOpsService, run-manager and
        // a graph mocked, which the reviewer ruled out. But the invariant is catastrophic
        // and SILENT when broken: mark-then-write means a throwing updateRunStatus leaves
        // handleFailure skipping the status flip, stranding the run at in_progress forever.
        // So this checks it structurally: every mark must sit closer to the status write
        // ABOVE it than to the one BELOW it.
        const src = readFileSync(join(__dirname, 'deep-run-executor.ts'), 'utf8');
        const lines = src.split('\n');
        const marks = lines
            .map((l, i) => ({ l, i }))
            .filter(({ l }) => /^\s*terminal\.written = true;\s*$/.test(l));
        const writes = lines
            .map((l, i) => ({ l, i }))
            .filter(({ l }) => l.includes('updateRunStatus(') && !l.includes("'in_progress'"))
            .map(({ i }) => i);

        expect(marks.length).toBeGreaterThan(0);
        expect(writes.length).toBeGreaterThan(0);

        for (const { i } of marks) {
            const above = writes.filter(w => w < i).pop();
            const below = writes.find(w => w > i);
            expect(above, `mark on line ${i + 1} has no status write above it`).toBeDefined();
            // Strictly nearer the write above than the write below → it follows its own write.
            if (below !== undefined) {
                expect(i - (above as number), `mark on line ${i + 1} is nearer the NEXT status write — it was set before its own write committed`)
                    .toBeLessThan(below - i);
            }
        }
    });
});
