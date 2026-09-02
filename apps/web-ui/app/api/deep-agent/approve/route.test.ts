import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../lib/deep-agent/deep-agent-graph', () => ({ createDeepAgentGraph: vi.fn() }));
vi.mock('../../../../lib/deep-agent/db/chat-history-store', () => ({
    appendMessage: vi.fn(), upsertTodos: vi.fn(),
}));
vi.mock('../../../../lib/deep-agent/logger', () => ({
    createLogger: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() }),
}));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn(), getAuthSession: vi.fn() }));

import { createDeepAgentGraph } from '../../../../lib/deep-agent/deep-agent-graph';
import { appendMessage, upsertTodos } from '../../../../lib/deep-agent/db/chat-history-store';
import { AuditService } from '@/lib/audit-service';
import { getSessionTenantId } from '@/lib/auth-session';
import { POST } from './route';

const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;
const makeInvalidJsonRequest = () => ({ json: vi.fn().mockRejectedValue(new Error('bad json')) }) as any;
const VALID_BODY = { threadId: 't1', decisions: [{ type: 'approve' }], config: { model: 'sonnet' } };

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

describe('POST /api/deep-agent/approve', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('returns 400 for invalid JSON body', async () => {
        const res = await POST(makeInvalidJsonRequest());
        expect(res.status).toBe(400);
    });

    it('returns 400 when threadId, decisions, or config is missing', async () => {
        const res = await POST(makeRequest({ threadId: 't1' }));
        expect(res.status).toBe(400);
    });

    it('logs a high-severity approval audit event before resuming', async () => {
        vi.mocked(createDeepAgentGraph).mockResolvedValue({
            agent: { stream: vi.fn().mockResolvedValue(fakeStream([])) },
        } as any);

        await POST(makeRequest(VALID_BODY));

        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'agent.run.approved', severity: 'high', tenantId: 'tenant-1' })
        );
    });

    it('returns 500 when graph creation fails', async () => {
        vi.mocked(createDeepAgentGraph).mockRejectedValue(new Error('bad model config'));
        const res = await POST(makeRequest(VALID_BODY));
        const body = await res.json();
        expect(res.status).toBe(500);
        expect(body.error).toContain('bad model config');
    });

    it('streams the resumed run and persists the assistant message', async () => {
        vi.mocked(createDeepAgentGraph).mockResolvedValue({
            agent: {
                stream: vi.fn().mockResolvedValue(fakeStream([
                    [[], { agent: { messages: [{ content: 'Continuing' }] } }],
                    [[], { tools: { messages: [{ name: 'a_tool', tool_call_id: 'tc1', content: 'result' }] } }],
                ])),
            },
        } as any);

        const res = await POST(makeRequest(VALID_BODY));
        const events = await readEvents(res);

        expect(events.map((e) => e.event)).toEqual(expect.arrayContaining(['text-delta', 'tool-result', 'done']));
        expect(appendMessage).toHaveBeenCalledWith(
            't1', expect.objectContaining({ role: 'assistant', content: 'Continuing' })
        );
        expect(res.headers.get('X-Thread-Id')).toBe('t1');
    });

    it('falls back to "unknown" in the audit log when the session tenant cannot be resolved', async () => {
        vi.mocked(getSessionTenantId).mockRejectedValue(new Error('no session'));
        vi.mocked(createDeepAgentGraph).mockResolvedValue({
            agent: { stream: vi.fn().mockResolvedValue(fakeStream([])) },
        } as any);

        await POST(makeRequest(VALID_BODY));

        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ tenantId: 'unknown' })
        );
    });

    it('skips subgraph chunks and tolerates a null entry in a tool-result messages array', async () => {
        vi.mocked(createDeepAgentGraph).mockResolvedValue({
            agent: {
                stream: vi.fn().mockResolvedValue(fakeStream([
                    [['subgraph-1'], { agent: { messages: [{ content: 'should be skipped' }] } }],
                    [[], { tools: { messages: [null, { name: 'a_tool', tool_call_id: 'tc2', content: 'ok' }] } }],
                ])),
            },
        } as any);

        const res = await POST(makeRequest(VALID_BODY));
        const events = await readEvents(res);

        const toolResults = events.filter((e) => e.event === 'tool-result');
        // The null entry (msg?.tool_call_id resolves to undefined) still produces an event —
        // it just carries no useful id/result — followed by the real tc2 result.
        expect(toolResults).toHaveLength(2);
        expect(toolResults[1].data).toMatchObject({ toolCallId: 'tc2', result: 'ok' });
        expect(JSON.stringify(events)).not.toContain('should be skipped');
    });

    it('persists todos when the resumed graph state carries them', async () => {
        vi.mocked(createDeepAgentGraph).mockResolvedValue({
            agent: {
                stream: vi.fn().mockResolvedValue(fakeStream([
                    [[], { agent: { messages: [], todos: [{ id: 'todo-1', title: 'x', status: 'pending' }] } }],
                ])),
            },
        } as any);

        const res = await POST(makeRequest(VALID_BODY));
        await readEvents(res);
        expect(upsertTodos).toHaveBeenCalledWith('t1', [{ id: 'todo-1', title: 'x', status: 'pending' }]);
    });

    it('extracts <think> blocks from additional_kwargs.reasoningContent (string form)', async () => {
        vi.mocked(createDeepAgentGraph).mockResolvedValue({
            agent: { stream: vi.fn().mockResolvedValue(fakeStream([
                [[], { agent: { messages: [{ content: 'answer', additional_kwargs: { reasoningContent: 'thinking hard' } }] } }],
            ])) },
        } as any);
        const res = await POST(makeRequest(VALID_BODY));
        const events = await readEvents(res);
        const delta = events.find((e) => e.event === 'text-delta');
        expect(delta.data.text).toContain('<think>\nthinking hard\n</think>');
        expect(delta.data.text).toContain('answer');
    });

    it('extracts <think> blocks from additional_kwargs.reasoningContent (object form)', async () => {
        vi.mocked(createDeepAgentGraph).mockResolvedValue({
            agent: { stream: vi.fn().mockResolvedValue(fakeStream([
                [[], { agent: { messages: [{ content: 'answer', additional_kwargs: { reasoningContent: { text: 'obj thinking' } } }] } }],
            ])) },
        } as any);
        const res = await POST(makeRequest(VALID_BODY));
        const events = await readEvents(res);
        const delta = events.find((e) => e.event === 'text-delta');
        expect(delta.data.text).toContain('<think>\nobj thinking\n</think>');
    });

    it('extracts <think> blocks from additional_kwargs.reasoning_content (deepseek-style)', async () => {
        vi.mocked(createDeepAgentGraph).mockResolvedValue({
            agent: { stream: vi.fn().mockResolvedValue(fakeStream([
                [[], { agent: { messages: [{ content: 'answer', additional_kwargs: { reasoning_content: 'deepseek thinking' } }] } }],
            ])) },
        } as any);
        const res = await POST(makeRequest(VALID_BODY));
        const events = await readEvents(res);
        const delta = events.find((e) => e.event === 'text-delta');
        expect(delta.data.text).toContain('<think>\ndeepseek thinking\n</think>');
    });

    it('extracts text from array-shaped content, wrapping thinking-type blocks in <think>', async () => {
        vi.mocked(createDeepAgentGraph).mockResolvedValue({
            agent: { stream: vi.fn().mockResolvedValue(fakeStream([
                [[], { agent: { messages: [{ content: [
                    { type: 'thinking', text: 'block thought' },
                    { type: 'text', text: 'block answer' },
                ] }] } }],
            ])) },
        } as any);
        const res = await POST(makeRequest(VALID_BODY));
        const events = await readEvents(res);
        const delta = events.find((e) => e.event === 'text-delta');
        expect(delta.data.text).toContain('<think>\nblock thought\n</think>');
        expect(delta.data.text).toContain('block answer');
    });

    it('truncates a tool result longer than 8000 characters', async () => {
        const longOutput = 'x'.repeat(8100);
        vi.mocked(createDeepAgentGraph).mockResolvedValue({
            agent: { stream: vi.fn().mockResolvedValue(fakeStream([
                [[], { tools: { messages: [{ name: 'a_tool', tool_call_id: 'tc1', content: longOutput }] } }],
            ])) },
        } as any);
        const res = await POST(makeRequest(VALID_BODY));
        const events = await readEvents(res);
        const toolResult = events.find((e) => e.event === 'tool-result');
        expect(toolResult.data.result).toContain('[truncated — 8100 total chars]');
        expect(toolResult.data.result.length).toBeLessThan(8100);
    });

    it('emits approval-required when the resumed run hits another interrupt', async () => {
        vi.mocked(createDeepAgentGraph).mockResolvedValue({
            agent: { stream: vi.fn().mockResolvedValue(fakeStream([
                [[], { __interrupt__: [{ value: { actionRequests: [{ name: 'stop_ec2' }], reviewConfigs: [] } }] }],
            ])) },
        } as any);
        const res = await POST(makeRequest(VALID_BODY));
        const events = await readEvents(res);
        const approval = events.find((e) => e.event === 'approval-required');
        expect(approval.data.actionRequests).toEqual([{ name: 'stop_ec2' }]);
    });

    it('persists todos emitted via a write_todos tool call', async () => {
        vi.mocked(createDeepAgentGraph).mockResolvedValue({
            agent: { stream: vi.fn().mockResolvedValue(fakeStream([
                [[], { agent: { messages: [{ content: '', tool_calls: [{ id: 'tc1', name: 'write_todos', args: { todos: [{ title: 'Do the thing' }] } }] }] } }],
            ])) },
        } as any);
        const res = await POST(makeRequest(VALID_BODY));
        const events = await readEvents(res);
        expect(events.some((e) => e.event === 'tool-call' && e.data.toolName === 'write_todos')).toBe(true);
        expect(upsertTodos).toHaveBeenCalledWith('t1', [expect.objectContaining({ title: 'Do the thing' })]);
    });

    it('emits an error event when the resumed stream throws mid-flight', async () => {
        vi.mocked(createDeepAgentGraph).mockResolvedValue({
            agent: {
                stream: vi.fn().mockResolvedValue((async function* () {
                    throw new Error('resume exploded');
                })()),
            },
        } as any);

        const res = await POST(makeRequest(VALID_BODY));
        const events = await readEvents(res);
        expect(events.some((e) => e.event === 'error' && e.data.message === 'resume exploded')).toBe(true);
    });

    it('falls back to "Stream error" when the thrown value has no message', async () => {
        vi.mocked(createDeepAgentGraph).mockResolvedValue({
            agent: {
                stream: vi.fn().mockResolvedValue((async function* () {
                    throw 'a plain string rejection';
                })()),
            },
        } as any);

        const res = await POST(makeRequest(VALID_BODY));
        const events = await readEvents(res);
        expect(events.some((e) => e.event === 'error' && e.data.message === 'Stream error')).toBe(true);
    });

    it('does not throw when the audit log write itself fails', async () => {
        vi.mocked(AuditService.logUserAction).mockRejectedValueOnce(new Error('audit sink down'));
        vi.mocked(createDeepAgentGraph).mockResolvedValue({
            agent: { stream: vi.fn().mockResolvedValue(fakeStream([])) },
        } as any);

        const res = await POST(makeRequest(VALID_BODY));
        await expect(readEvents(res)).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ event: 'done' })]));
    });

    it('handles extractText edge cases: non-string/non-array content, an invalid reasoningContent shape, and empty thinking text', async () => {
        vi.mocked(createDeepAgentGraph).mockResolvedValue({
            agent: { stream: vi.fn().mockResolvedValue(fakeStream([
                [[], { agent: { messages: [
                    { content: 42 },
                    { content: 'x', additional_kwargs: { reasoningContent: { notText: 'nope' } } },
                    { content: [{ type: 'thinking', text: '' }, { type: 'text' }] },
                ] } }],
            ])) },
        } as any);

        const res = await POST(makeRequest(VALID_BODY));
        const events = await readEvents(res);
        const deltas = events.filter((e) => e.event === 'text-delta').map((e) => e.data.text).join('');
        expect(deltas).toBe('x');
    });

    it('skips approval-required when a resumed __interrupt__ chunk carries no value at either lookup path', async () => {
        vi.mocked(createDeepAgentGraph).mockResolvedValue({
            agent: { stream: vi.fn().mockResolvedValue(fakeStream([
                [[], { __interrupt__: [{}] }],
            ])) },
        } as any);

        const res = await POST(makeRequest(VALID_BODY));
        const events = await readEvents(res);
        expect(events.some((e) => e.event === 'approval-required')).toBe(false);
        expect(events.some((e) => e.event === 'done')).toBe(true);
    });

    it('skips todo persistence when a write_todos call\'s args.todos is not an array', async () => {
        vi.mocked(createDeepAgentGraph).mockResolvedValue({
            agent: { stream: vi.fn().mockResolvedValue(fakeStream([
                [[], { agent: { messages: [{
                    content: '', tool_calls: [{ id: 'tc1', name: 'write_todos', args: { todos: 'not-an-array' } }],
                }] } }],
            ])) },
        } as any);

        const res = await POST(makeRequest(VALID_BODY));
        const events = await readEvents(res);
        expect(events.some((e) => e.event === 'tool-call' && e.data.toolName === 'write_todos')).toBe(true);
        expect(events.some((e) => e.event === 'todo-update')).toBe(false);
        expect(upsertTodos).not.toHaveBeenCalled();
    });
});
