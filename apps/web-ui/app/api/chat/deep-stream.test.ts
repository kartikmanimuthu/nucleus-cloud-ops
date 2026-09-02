import { describe, it, expect, vi, afterEach } from 'vitest';
import { processDeepStream, type DeepStreamOptions } from './deep-stream';

/**
 * processDeepStream is a ReadableStream built from four independently-consumed
 * projections (messages/toolCalls/subagents/values). These tests build minimal
 * fake async iterables for each and drain the stream to completion, asserting
 * on the UIMessageChunk sequence — the same technique as
 * __tests__/deep-stream-heartbeat.test.ts, without needing fake timers since
 * every fixture here resolves well inside the 15s heartbeat tick.
 */

function asyncIterable<T>(items: T[]): AsyncIterable<T> {
    return {
        async *[Symbol.asyncIterator]() {
            for (const item of items) yield item;
        },
    };
}

function mockMessage(opts: { node?: string; textParts?: string[]; usage?: { input_tokens?: number; output_tokens?: number } } = {}) {
    return {
        node: opts.node,
        text: asyncIterable(opts.textParts ?? []),
        reasoning: asyncIterable([]),
        usage: Promise.resolve(opts.usage),
    };
}

function mockToolCall(opts: {
    name?: string; callId?: string; input?: unknown;
    output?: Promise<unknown>; status?: Promise<'running' | 'finished' | 'error'>; error?: Promise<string | undefined>;
}) {
    return {
        name: opts.name ?? 'my_tool',
        callId: opts.callId ?? 'call-1',
        input: opts.input ?? {},
        output: opts.output ?? Promise.resolve('result'),
        status: opts.status ?? Promise.resolve<'running' | 'finished' | 'error'>('finished'),
        error: opts.error ?? Promise.resolve(undefined),
    };
}

function mockSubagent(opts: {
    name?: string; taskInput?: Promise<unknown>; output?: Promise<unknown>;
    toolCalls?: ReturnType<typeof mockToolCall>[]; messages?: ReturnType<typeof mockMessage>[];
}) {
    return {
        name: opts.name ?? 'sub',
        taskInput: opts.taskInput ?? Promise.resolve('task'),
        output: opts.output ?? Promise.resolve('sub output'),
        toolCalls: asyncIterable(opts.toolCalls ?? []),
        messages: asyncIterable(opts.messages ?? []),
    };
}

function mockRun(opts: {
    messages?: ReturnType<typeof mockMessage>[];
    toolCalls?: ReturnType<typeof mockToolCall>[];
    subagents?: ReturnType<typeof mockSubagent>[];
    values?: Record<string, unknown>[];
}) {
    return {
        messages: asyncIterable(opts.messages ?? []),
        toolCalls: asyncIterable(opts.toolCalls ?? []),
        subagents: asyncIterable(opts.subagents ?? []),
        values: asyncIterable(opts.values ?? []),
        interrupted: false,
        [Symbol.asyncIterator]: asyncIterable([])[Symbol.asyncIterator],
    };
}

/** Resolves after the microtask queue drains, so it settles strictly after any in-flight
 *  async-generator iteration (which is a plain microtask, not a macrotask) — used to pin
 *  down ordering between a subagent's `output` and its concurrently-drained `toolCalls`. */
function afterMicrotasks<T>(value: T): Promise<T> {
    return new Promise(resolve => setTimeout(() => resolve(value), 0));
}

async function collectAll(stream: ReadableStream): Promise<any[]> {
    const chunks: any[] = [];
    const reader = stream.getReader();
    for (; ;) {
        const { done, value } = await reader.read();
        if (done) return chunks;
        chunks.push(value);
    }
}

function run(opts: Partial<DeepStreamOptions> & { run: ReturnType<typeof mockRun> }): Promise<any[]> {
    const stream = processDeepStream({
        threadId: 't1',
        releaseLock: () => { },
        getInterruptState: async () => ({ tasks: [] }),
        ...opts,
    } as DeepStreamOptions);
    return collectAll(stream);
}

afterEach(() => vi.restoreAllMocks());

describe('processDeepStream', () => {
    it('streams model text as text-start/delta/end and reports usage', async () => {
        const onUsage = vi.fn();
        const chunks = await run({
            run: mockRun({ messages: [mockMessage({ textParts: ['Hello', ' world'], usage: { input_tokens: 10, output_tokens: 5 } })] }),
            onUsage,
        });

        expect(chunks.find(c => c.type === 'text-start')).toBeDefined();
        expect(chunks.filter(c => c.type === 'text-delta').map(c => c.delta)).toEqual(['Hello', ' world']);
        expect(chunks.find(c => c.type === 'text-end')).toBeDefined();
        expect(chunks.find(c => c.type === 'data-usage')?.data).toEqual({ input: 10, output: 5 });
        expect(onUsage).toHaveBeenCalledWith(10, 5);
    });

    it('emits no text part when every delta is falsy', async () => {
        const chunks = await run({ run: mockRun({ messages: [mockMessage({ textParts: ['', ''] })] }) });
        expect(chunks.find(c => c.type === 'text-start' && c.id?.startsWith('text-'))).toBeUndefined();
    });

    it('skips the usage part when both token counts are zero', async () => {
        const onUsage = vi.fn();
        const chunks = await run({ run: mockRun({ messages: [mockMessage({ textParts: ['hi'], usage: { input_tokens: 0, output_tokens: 0 } })] }), onUsage });
        expect(chunks.find(c => c.type === 'data-usage')).toBeUndefined();
        expect(onUsage).not.toHaveBeenCalled();
    });

    it('routes a memory-recall node to a memory part and onMemoryText, skipping the plain text path', async () => {
        const onMemoryText = vi.fn();
        const chunks = await run({
            run: mockRun({ messages: [mockMessage({ node: 'DeepMemoryMiddleware.before_model', textParts: ['recalled fact'] })] }),
            onMemoryText,
        });

        expect(chunks.find(c => c.type === 'data-phase')?.data.phase).toBe('memory_recall');
        expect(chunks.find(c => c.type === 'data-memory')).toBeDefined();
        expect(onMemoryText).toHaveBeenCalledWith('recall', 'recalled fact');
        expect(chunks.find(c => c.type === 'text-start')).toBeUndefined();
    });

    it('routes a memory-save node to op "save"', async () => {
        const onMemoryText = vi.fn();
        const chunks = await run({
            run: mockRun({ messages: [mockMessage({ node: 'DeepMemoryMiddleware.after_model', textParts: ['saved fact'] })] }),
            onMemoryText,
        });
        expect(chunks.find(c => c.type === 'data-phase')?.data.phase).toBe('memory_save');
        expect(onMemoryText).toHaveBeenCalledWith('save', 'saved fact');
    });

    it('does not emit a memory part when the recalled/saved text is blank', async () => {
        const onMemoryText = vi.fn();
        const chunks = await run({
            run: mockRun({ messages: [mockMessage({ node: 'DeepMemoryMiddleware.before_model', textParts: ['   '] })] }),
            onMemoryText,
        });
        expect(chunks.find(c => c.type === 'data-memory')).toBeUndefined();
        expect(onMemoryText).not.toHaveBeenCalled();
    });

    it('sends the tool result for a finished, non-task tool call', async () => {
        const chunks = await run({
            run: mockRun({ toolCalls: [mockToolCall({ name: 'read_file', callId: 'c1', output: Promise.resolve('file contents') })] }),
        });
        expect(chunks.find(c => c.type === 'tool-input-start')?.toolName).toBe('read_file');
        expect(chunks.find(c => c.type === 'tool-output-available')?.output).toBe('file contents');
    });

    it('summarizes a JSON-object tool output via outputText', async () => {
        const chunks = await run({
            run: mockRun({ toolCalls: [mockToolCall({ name: 'search', output: Promise.resolve({ content: { hits: 3 } }) })] }),
        });
        expect(chunks.find(c => c.type === 'tool-output-available')?.output).toBe(JSON.stringify({ hits: 3 }));
    });

    it('replaces a finished "task" tool call output with a delegation message naming the subagent type', async () => {
        const chunks = await run({
            run: mockRun({ toolCalls: [mockToolCall({ name: 'task', input: { subagent_type: 'researcher' } })] }),
        });
        expect(chunks.find(c => c.type === 'tool-output-available')?.output).toBe(
            'Delegated to researcher — see the sub-agent card for its findings.',
        );
    });

    it('falls back to "sub-agent" in the delegation message when subagent_type is missing', async () => {
        const chunks = await run({ run: mockRun({ toolCalls: [mockToolCall({ name: 'task', input: {} })] }) });
        expect(chunks.find(c => c.type === 'tool-output-available')?.output).toBe(
            'Delegated to sub-agent — see the sub-agent card for its findings.',
        );
    });

    it('reports a failed tool call as an Error output', async () => {
        const chunks = await run({
            run: mockRun({
                toolCalls: [mockToolCall({ name: 'write_file', status: Promise.resolve('error'), error: Promise.resolve('disk full') })],
            }),
        });
        expect(chunks.find(c => c.type === 'tool-output-available')?.output).toBe('Error: disk full');
    });

    it('emits no output part for a tool call that never settles to finished or error', async () => {
        const chunks = await run({
            run: mockRun({ toolCalls: [mockToolCall({ name: 'still_running', status: Promise.resolve('running') })] }),
        });
        expect(chunks.find(c => c.type === 'tool-output-available')).toBeUndefined();
        expect(chunks.find(c => c.type === 'tool-input-start')).toBeDefined();
    });

    it('summarizes the remaining outputText shapes: content-string, no-content object, and null', async () => {
        const chunks = await run({
            run: mockRun({
                toolCalls: [
                    mockToolCall({ callId: 'c-str', name: 't1', output: Promise.resolve({ content: 'plain text' }) }),
                    mockToolCall({ callId: 'c-obj', name: 't2', output: Promise.resolve({ foo: 1 }) }),
                    mockToolCall({ callId: 'c-null', name: 't3', output: Promise.resolve(null) }),
                ],
            }),
        });
        const outputs = chunks.filter(c => c.type === 'tool-output-available');
        expect(outputs.find(o => o.toolCallId === 'c-str')?.output).toBe('plain text');
        expect(outputs.find(o => o.toolCallId === 'c-obj')?.output).toBe(JSON.stringify({ foo: 1 }));
        expect(outputs.find(o => o.toolCallId === 'c-null')?.output).toBe(JSON.stringify(''));
    });

    it('swallows every internal watcher rejection (tool output/error, text iteration, usage, subagent messages/toolCalls/taskInput) without crashing the run', async () => {
        const throwing = (): AsyncIterable<never> => ({
            async *[Symbol.asyncIterator]() { throw new Error('blew up'); },
        });

        const chunks = await run({
            run: mockRun({
                messages: [
                    { node: undefined, text: throwing(), reasoning: asyncIterable([]), usage: Promise.reject(new Error('usage failed')) },
                    {
                        node: 'DeepMemoryMiddleware.before_model', text: throwing(), reasoning: asyncIterable([]),
                        usage: Promise.reject(new Error('usage failed')),
                    },
                ] as any,
                toolCalls: [mockToolCall({
                    output: Promise.reject(new Error('output failed')),
                    error: Promise.reject(new Error('error failed')),
                    status: Promise.resolve('finished'),
                })],
                subagents: [{
                    name: 'flaky-internals',
                    taskInput: Promise.reject(new Error('taskInput failed')),
                    output: Promise.resolve('ok'),
                    toolCalls: throwing(),
                    messages: throwing(),
                }] as any,
            }),
        });

        expect(chunks.find(c => c.type === 'finish')).toBeDefined();
    });

    it('drives a subagent card from running through tool calls to done, with aggregated usage', async () => {
        const onSubagentEvent = vi.fn();
        const chunks = await run({
            run: mockRun({
                subagents: [mockSubagent({
                    name: 'planner',
                    toolCalls: [mockToolCall({ name: 'grep' })],
                    messages: [mockMessage({ usage: { input_tokens: 4, output_tokens: 2 } })],
                    output: afterMicrotasks('subagent finished result'),
                })],
            }),
            onSubagentEvent,
        });

        const subagentChunks = chunks.filter(c => c.type === 'data-subagent');
        expect(subagentChunks[0].data.status).toBe('running');
        const done = subagentChunks[subagentChunks.length - 1].data;
        expect(done.status).toBe('done');
        expect(done.summary).toBe('subagent finished result');
        expect(done.toolCount).toBe(1);
        expect(done.lastTool).toBe('grep');
        expect(done.tokensIn).toBe(4);
        expect(done.tokensOut).toBe(2);
        expect(onSubagentEvent).toHaveBeenCalledWith(expect.objectContaining({ status: 'done' }));
    });

    it('marks a subagent card failed when its output promise rejects', async () => {
        const chunks = await run({
            run: mockRun({ subagents: [mockSubagent({ name: 'flaky', output: Promise.reject(new Error('boom')) })] }),
        });
        const subagentChunks = chunks.filter(c => c.type === 'data-subagent');
        expect(subagentChunks[subagentChunks.length - 1].data.status).toBe('failed');
    });

    it('emits a plan-rail part for a new todos snapshot and dedupes an identical repeat', async () => {
        const todos = [{ content: 'step one', status: 'pending' as const }];
        const chunks = await run({ run: mockRun({ values: [{ todos }, { todos }] }) });
        expect(chunks.filter(c => c.type === 'data-plan')).toHaveLength(1);
        expect(chunks.find(c => c.type === 'data-plan')?.data.steps).toEqual([{ step: 'step one', status: 'pending' }]);
    });

    it('ignores a values snapshot with no todos array', async () => {
        const chunks = await run({ run: mockRun({ values: [{ other: 1 }, { todos: [] }] }) });
        expect(chunks.find(c => c.type === 'data-plan')).toBeUndefined();
    });

    it('replays synthetic decisions (rejections decided without executing) as complete tool cards', async () => {
        const chunks = await run({
            run: mockRun({}),
            syntheticDecisionResults: [{ toolCallId: 's1', toolName: 'delete_resource', args: { id: 'x' }, output: 'Rejected by user' }],
        });
        expect(chunks.find(c => c.type === 'tool-input-start' && c.toolCallId === 's1')).toBeDefined();
        expect(chunks.find(c => c.type === 'tool-output-available' && c.toolCallId === 's1')?.output).toBe('Rejected by user');
    });

    it('emits an empty placeholder text part when nothing else was emitted', async () => {
        const chunks = await run({ run: mockRun({}) });
        const id = `empty-t1`;
        expect(chunks.find(c => c.type === 'text-start' && c.id === id)).toBeDefined();
        expect(chunks.find(c => c.type === 'text-delta' && c.id === id)?.delta).toBe(' ');
        expect(chunks.find(c => c.type === 'text-end' && c.id === id)).toBeDefined();
    });

    it('splits pending interrupts into an approval batch and clarification parts, approval first', async () => {
        const chunks = await run({
            run: mockRun({}),
            getInterruptState: async () => ({
                tasks: [{
                    interrupts: [{
                        id: 'int-1',
                        value: {
                            actionRequests: [
                                { name: 'delete_instance', args: { id: 'i-1' } },
                                { name: 'ask_user', args: { question: 'Which region?', options: ['us-east-1', 'us-west-2'] } },
                            ],
                        },
                    }],
                }],
            }),
        });

        const approvalIdx = chunks.findIndex(c => c.type === 'data-approval');
        const clarifyIdx = chunks.findIndex(c => c.type === 'data-clarification');
        expect(approvalIdx).toBeGreaterThanOrEqual(0);
        expect(clarifyIdx).toBeGreaterThan(approvalIdx);
        expect(chunks[approvalIdx].data.tools).toEqual([
            expect.objectContaining({ toolName: 'delete_instance', args: { id: 'i-1' } }),
        ]);
        expect(chunks[clarifyIdx].data).toEqual({
            toolCallId: expect.any(String),
            question: 'Which region?',
            options: ['us-east-1', 'us-west-2'],
        });
    });

    it('still emits an approval batch with an empty tools array when every pending action is a clarification', async () => {
        const chunks = await run({
            run: mockRun({}),
            getInterruptState: async () => ({
                tasks: [{ interrupts: [{ id: 'int-2', value: { actionRequests: [{ name: 'ask_user', args: { question: 'ok?' } }] } }] }],
            }),
        });
        expect(chunks.find(c => c.type === 'data-approval')?.data.tools).toEqual([]);
    });

    it('defaults a clarification question and options when the args omit them', async () => {
        const chunks = await run({
            run: mockRun({}),
            getInterruptState: async () => ({
                tasks: [{ interrupts: [{ id: 'int-3', value: { actionRequests: [{ name: 'ask_user', args: {} }] } }] }],
            }),
        });
        const clarification = chunks.find(c => c.type === 'data-clarification');
        expect(clarification?.data.question).toBe('The agent needs your input.');
        expect(clarification?.data.options).toEqual([]);
    });

    it('sends an error chunk and logs to console.error on a non-abort failure', async () => {
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
        const badRun = mockRun({});
        (badRun as any).messages = { [Symbol.asyncIterator]() { return { next: () => Promise.reject(new Error('stream blew up')) }; } };

        const chunks = await run({ run: badRun });
        expect(chunks.find(c => c.type === 'error')?.errorText).toBe('stream blew up');
        expect(errSpy).toHaveBeenCalled();
    });

    it('swallows an AbortError without emitting an error chunk', async () => {
        const badRun = mockRun({});
        const abortError = Object.assign(new Error('cancelled'), { name: 'AbortError' });
        (badRun as any).messages = { [Symbol.asyncIterator]() { return { next: () => Promise.reject(abortError) }; } };

        const chunks = await run({ run: badRun });
        expect(chunks.find(c => c.type === 'error')).toBeUndefined();
    });

    it('always calls releaseLock and onFinish, and logs rather than throws when onFinish rejects', async () => {
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
        const releaseLock = vi.fn();
        const onFinish = vi.fn().mockRejectedValue(new Error('finish failed'));

        await run({ run: mockRun({}), releaseLock, onFinish });

        expect(releaseLock).toHaveBeenCalledTimes(1);
        expect(onFinish).toHaveBeenCalledTimes(1);
        expect(errSpy).toHaveBeenCalledWith('[DeepStream] onFinish failed:', expect.any(Error));
    });

    it('sends the active-skill part when a skill is active', async () => {
        const chunks = await run({ run: mockRun({}), activeSkill: { slug: 'aws-cost', source: 'auto' } });
        expect(chunks.find(c => c.type === 'data-skill')?.data).toEqual({ slug: 'aws-cost', source: 'auto' });
    });
});
