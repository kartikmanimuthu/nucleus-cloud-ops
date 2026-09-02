import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../lib/deep-agent/deep-agent-graph', () => ({ createDeepAgentGraph: vi.fn() }));
vi.mock('../../../../lib/deep-agent/db/chat-history-store', () => ({
    createThread: vi.fn(), getThread: vi.fn(), appendMessage: vi.fn(), upsertTodos: vi.fn(), updateThread: vi.fn(),
}));
vi.mock('../../../../lib/deep-agent/logger', () => ({
    createLogger: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() }),
}));

import { createDeepAgentGraph } from '../../../../lib/deep-agent/deep-agent-graph';
import { createThread, getThread, appendMessage, upsertTodos } from '../../../../lib/deep-agent/db/chat-history-store';
import { POST } from './route';

const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;
const makeInvalidJsonRequest = () => ({ json: vi.fn().mockRejectedValue(new Error('bad json')) }) as any;

async function readEvents(res: Response): Promise<Array<{ event: string; data: any }>> {
    const text = await res.text();
    return text
        .split('\n\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line.replace(/^data: /, '')));
}

async function* fakeStream(chunks: Array<[string[], any]>) {
    for (const chunk of chunks) yield chunk;
}

describe('POST /api/deep-agent/chat', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getThread).mockResolvedValue({ threadId: 't1' } as any);
    });

    it('returns 400 for invalid JSON body', async () => {
        const res = await POST(makeInvalidJsonRequest());
        expect(res.status).toBe(400);
    });

    it('returns 400 when config is missing', async () => {
        const res = await POST(makeRequest({ message: 'hi' }));
        expect(res.status).toBe(400);
    });

    it('returns 500 when graph creation fails', async () => {
        vi.mocked(createDeepAgentGraph).mockRejectedValue(new Error('bad model config'));
        const res = await POST(makeRequest({ message: 'hi', config: { model: 'bad' } }));
        const body = await res.json();
        expect(res.status).toBe(500);
        expect(body.error).toContain('bad model config');
    });

    it('creates a new thread and persists the user message when the thread does not exist', async () => {
        vi.mocked(getThread).mockResolvedValue(null);
        vi.mocked(createDeepAgentGraph).mockResolvedValue({
            agent: { stream: vi.fn().mockResolvedValue(fakeStream([])) },
            skillFiles: {},
        } as any);

        const res = await POST(makeRequest({ message: 'Hello', config: { model: 'sonnet' } }));
        await readEvents(res);

        expect(createThread).toHaveBeenCalledWith(expect.any(String), 'Hello', 'sonnet');
        expect(appendMessage).toHaveBeenCalledWith(
            expect.any(String), expect.objectContaining({ role: 'user', content: 'Hello' })
        );
    });

    it('does not persist a user message on resume', async () => {
        vi.mocked(createDeepAgentGraph).mockResolvedValue({
            agent: { stream: vi.fn().mockResolvedValue(fakeStream([])) },
            skillFiles: {},
        } as any);

        await POST(makeRequest({
            threadId: 't1', config: { model: 'sonnet' }, resume: { decisions: [{ type: 'approve' }] },
        }));

        expect(appendMessage).not.toHaveBeenCalled();
    });

    it('streams text deltas, a tool call with write_todos, tool results, an interrupt, and persists the assistant message', async () => {
        vi.mocked(createDeepAgentGraph).mockResolvedValue({
            agent: {
                stream: vi.fn().mockResolvedValue(fakeStream([
                    [[], { agent: { messages: [{ content: 'Hello ' }] } }],
                    [['subgraph'], { ignored: { messages: [{ content: 'skip me' }] } }],
                    [[], { agent: { messages: [{
                        content: 'world',
                        tool_calls: [{ id: 'tc1', name: 'write_todos', args: { todos: [{ title: 'Do X' }] } }],
                    }] } }],
                    [[], { tools: { messages: [{ name: 'write_todos', tool_call_id: 'tc1', content: 'ok' }] } }],
                    [[], { __interrupt__: [{ value: { actionRequests: [{ name: 'risky_tool' }], reviewConfigs: [] } }] }],
                ])),
            },
            skillFiles: {},
        } as any);

        const res = await POST(makeRequest({ threadId: 't1', message: 'Hi', config: { model: 'sonnet' } }));
        const events = await readEvents(res);
        const eventNames = events.map((e) => e.event);

        expect(eventNames).toEqual(
            expect.arrayContaining(['text-delta', 'tool-call', 'todo-update', 'tool-result', 'approval-required', 'done'])
        );
        expect(upsertTodos).toHaveBeenCalledWith('t1', [expect.objectContaining({ title: 'Do X' })]);
        expect(appendMessage).toHaveBeenCalledWith(
            expect.any(String), expect.objectContaining({ role: 'assistant', content: 'Hello world' })
        );
        expect(res.headers.get('Content-Type')).toBe('text/event-stream');
        expect(res.headers.get('X-Thread-Id')).toBe('t1');
    });

    it('extracts <think> blocks from reasoningContent/reasoning_content and array-shaped content', async () => {
        vi.mocked(createDeepAgentGraph).mockResolvedValue({
            agent: { stream: vi.fn().mockResolvedValue(fakeStream([
                [[], { agent: { messages: [
                    { content: 'a1', additional_kwargs: { reasoningContent: 'string think' } },
                    { content: 'a2', additional_kwargs: { reasoningContent: { text: 'obj think' } } },
                    { content: 'a3', additional_kwargs: { reasoning_content: 'deepseek think' } },
                    { content: [{ type: 'thinking', text: 'block think' }, { type: 'text', text: 'block answer' }] },
                ] } }],
            ])) },
            skillFiles: {},
        } as any);

        const res = await POST(makeRequest({ threadId: 't1', message: 'Hi', config: { model: 'sonnet' } }));
        const events = await readEvents(res);
        const deltas = events.filter((e) => e.event === 'text-delta').map((e) => e.data.text).join('');
        expect(deltas).toContain('<think>\nstring think\n</think>');
        expect(deltas).toContain('<think>\nobj think\n</think>');
        expect(deltas).toContain('<think>\ndeepseek think\n</think>');
        expect(deltas).toContain('<think>\nblock think\n</think>');
        expect(deltas).toContain('block answer');
    });

    it('truncates a tool result longer than 8000 characters', async () => {
        const longOutput = 'x'.repeat(8100);
        vi.mocked(createDeepAgentGraph).mockResolvedValue({
            agent: { stream: vi.fn().mockResolvedValue(fakeStream([
                [[], { tools: { messages: [{ name: 'a_tool', tool_call_id: 'tc1', content: longOutput }] } }],
            ])) },
            skillFiles: {},
        } as any);

        const res = await POST(makeRequest({ threadId: 't1', message: 'Hi', config: { model: 'sonnet' } }));
        const events = await readEvents(res);
        const toolResult = events.find((e) => e.event === 'tool-result');
        expect(toolResult.data.result).toContain('[truncated — 8100 total chars]');
    });

    it('skips a null/falsy entry in a node\'s messages array', async () => {
        vi.mocked(createDeepAgentGraph).mockResolvedValue({
            agent: { stream: vi.fn().mockResolvedValue(fakeStream([
                [[], { agent: { messages: [null, { content: 'ok' }] } }],
            ])) },
            skillFiles: {},
        } as any);

        const res = await POST(makeRequest({ threadId: 't1', message: 'Hi', config: { model: 'sonnet' } }));
        const events = await readEvents(res);
        expect(events.some((e) => e.event === 'text-delta' && e.data.text === 'ok')).toBe(true);
    });

    it('persists todos pushed directly on the graph node state (not via a tool call)', async () => {
        vi.mocked(createDeepAgentGraph).mockResolvedValue({
            agent: { stream: vi.fn().mockResolvedValue(fakeStream([
                [[], { agent: { messages: [], todos: [{ id: 'todo-1', title: 'x', status: 'pending' }] } }],
            ])) },
            skillFiles: {},
        } as any);

        const res = await POST(makeRequest({ threadId: 't1', message: 'Hi', config: { model: 'sonnet' } }));
        await readEvents(res);
        expect(upsertTodos).toHaveBeenCalledWith('t1', [{ id: 'todo-1', title: 'x', status: 'pending' }]);
    });

    it('resumes via a Command when `resume` is provided instead of a new message', async () => {
        const stream = vi.fn().mockResolvedValue(fakeStream([]));
        vi.mocked(createDeepAgentGraph).mockResolvedValue({ agent: { stream }, skillFiles: {} } as any);

        await POST(makeRequest({ threadId: 't1', config: { model: 'sonnet' }, resume: { decisions: [{ type: 'approve' }] } }));
        expect(stream).toHaveBeenCalled();
        const invokeInput = stream.mock.calls[0][0];
        expect(invokeInput).toEqual(expect.objectContaining({ resume: { decisions: [{ type: 'approve' }] } }));
    });

    it('handles extractText edge cases: non-string/non-array content, an invalid reasoningContent shape, and empty thinking text', async () => {
        vi.mocked(createDeepAgentGraph).mockResolvedValue({
            agent: { stream: vi.fn().mockResolvedValue(fakeStream([
                [[], { agent: { messages: [
                    { content: 42 }, // neither string nor array -> extractText returns ''
                    { content: 'x', additional_kwargs: { reasoningContent: { notText: 'nope' } } }, // rc.text not a string -> no <think>
                    { content: [{ type: 'thinking', text: '' }, { type: 'text' }] }, // falsy thinking text + item with neither text nor content
                ] } }],
            ])) },
            skillFiles: {},
        } as any);

        const res = await POST(makeRequest({ threadId: 't1', message: 'Hi', config: { model: 'sonnet' } }));
        const events = await readEvents(res);
        const deltas = events.filter((e) => e.event === 'text-delta').map((e) => e.data.text).join('');
        expect(deltas).toBe('x');
    });

    it('skips approval-required when an __interrupt__ chunk carries no value at either lookup path', async () => {
        vi.mocked(createDeepAgentGraph).mockResolvedValue({
            agent: { stream: vi.fn().mockResolvedValue(fakeStream([
                [[], { __interrupt__: [{}] }],
            ])) },
            skillFiles: {},
        } as any);

        const res = await POST(makeRequest({ threadId: 't1', message: 'Hi', config: { model: 'sonnet' } }));
        const events = await readEvents(res);
        expect(events.some((e) => e.event === 'approval-required')).toBe(false);
        expect(events.some((e) => e.event === 'done')).toBe(true);
    });

    it('silently ignores a write_todos call whose args throw while being mapped', async () => {
        const throwingTodo = {};
        Object.defineProperty(throwingTodo, 'description', { get() { throw new Error('boom'); } });
        vi.mocked(createDeepAgentGraph).mockResolvedValue({
            agent: { stream: vi.fn().mockResolvedValue(fakeStream([
                [[], { agent: { messages: [{
                    content: '', tool_calls: [{ id: 'tc1', name: 'write_todos', args: { todos: [throwingTodo] } }],
                }] } }],
            ])) },
            skillFiles: {},
        } as any);

        const res = await POST(makeRequest({ threadId: 't1', message: 'Hi', config: { model: 'sonnet' } }));
        const events = await readEvents(res);
        expect(events.some((e) => e.event === 'todo-update')).toBe(false);
        expect(upsertTodos).not.toHaveBeenCalled();
        expect(events.some((e) => e.event === 'done')).toBe(true);
    });

    it('emits an error event when the stream throws mid-flight', async () => {
        vi.mocked(createDeepAgentGraph).mockResolvedValue({
            agent: {
                stream: vi.fn().mockResolvedValue((async function* () {
                    throw new Error('stream exploded');
                })()),
            },
            skillFiles: {},
        } as any);

        const res = await POST(makeRequest({ threadId: 't1', message: 'Hi', config: { model: 'sonnet' } }));
        const events = await readEvents(res);
        expect(events.some((e) => e.event === 'error' && e.data.message === 'stream exploded')).toBe(true);
    });
});
