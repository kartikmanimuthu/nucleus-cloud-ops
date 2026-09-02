import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('@/lib/auth-options', () => ({ authOptions: {} }));
vi.mock('@/lib/agent/text-to-sql', () => ({ invokeTextToSQL: vi.fn() }));

import { getServerSession } from 'next-auth';
import { invokeTextToSQL } from '@/lib/agent/text-to-sql';
import { POST } from './route';

const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;

async function* singleEventStream(events: Array<Record<string, unknown>>) {
    for (const e of events) yield e;
}

async function readSSE(res: Response): Promise<Array<Record<string, unknown>>> {
    const text = await res.text();
    return text
        .split('\n\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line.replace(/^data: /, '')));
}

describe('POST /api/ask-ai', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getServerSession).mockResolvedValue({ user: { activeTenantId: 'tenant-1' } } as any);
    });

    it('returns 401 when there is no session', async () => {
        vi.mocked(getServerSession).mockResolvedValue(null as any);
        const res = await POST(makeRequest({ prompt: 'How many EC2 instances?' }));
        expect(res.status).toBe(401);
        expect(invokeTextToSQL).not.toHaveBeenCalled();
    });

    it('returns 400 when no prompt/query/message content is present', async () => {
        const res = await POST(makeRequest({}));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.error).toBe('Query is required');
    });

    it('defaults tenantId to "default" when the session has no activeTenantId', async () => {
        vi.mocked(getServerSession).mockResolvedValue({ user: {} } as any);
        vi.mocked(invokeTextToSQL).mockReturnValue(singleEventStream([]) as any);

        await POST(makeRequest({ prompt: 'x' }));
        expect(invokeTextToSQL).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'default' }));
    });

    it('derives the prompt from the last message when prompt/query are absent', async () => {
        vi.mocked(invokeTextToSQL).mockReturnValue(singleEventStream([]) as any);
        await POST(makeRequest({ messages: [{ role: 'user', content: 'How many buckets?' }] }));
        expect(invokeTextToSQL).toHaveBeenCalledWith(expect.objectContaining({ question: 'How many buckets?' }));
    });

    it('maps accountId (singular) to accountIds (array) in agent filters', async () => {
        vi.mocked(invokeTextToSQL).mockReturnValue(singleEventStream([]) as any);
        await POST(makeRequest({ prompt: 'x', filters: { accountId: 'acc-1', region: 'us-east-1' } }));
        expect(invokeTextToSQL).toHaveBeenCalledWith(expect.objectContaining({
            filters: { accountIds: ['acc-1'], region: 'us-east-1', resourceType: undefined },
        }));
    });

    it('builds conversation history from prior messages, excluding the last one', async () => {
        vi.mocked(invokeTextToSQL).mockReturnValue(singleEventStream([]) as any);
        await POST(makeRequest({
            messages: [
                { role: 'user', content: 'first' },
                { role: 'assistant', content: 'reply' },
                { role: 'user', content: 'second' },
            ],
        }));
        expect(invokeTextToSQL).toHaveBeenCalledWith(expect.objectContaining({
            conversationHistory: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'reply' }],
        }));
    });

    it('streams SSE events and persists the final answer for multi-turn use', async () => {
        vi.mocked(invokeTextToSQL).mockReturnValue(singleEventStream([
            { type: 'token', content: 'Hello ' },
            { type: 'token', content: 'world' },
            { type: 'done' },
        ]) as any);

        const res = await POST(makeRequest({ prompt: 'x', conversationId: 'conv-1' }));
        const events = await readSSE(res);

        expect(res.headers.get('Content-Type')).toBe('text/event-stream');
        expect(events).toEqual([
            { type: 'token', content: 'Hello ' },
            { type: 'token', content: 'world' },
            { type: 'done' },
        ]);

        // Second call on the same conversationId should carry forward the stored history.
        vi.mocked(invokeTextToSQL).mockReturnValue(singleEventStream([]) as any);
        await POST(makeRequest({ prompt: 'follow-up', conversationId: 'conv-1' }));
        expect(invokeTextToSQL).toHaveBeenLastCalledWith(expect.objectContaining({
            conversationHistory: [
                { role: 'user', content: 'x' },
                { role: 'assistant', content: 'Hello world' },
            ],
        }));
    });

    it('emits an error SSE event and closes cleanly when the agent stream throws', async () => {
        vi.mocked(invokeTextToSQL).mockReturnValue((async function* () {
            throw new Error('Bedrock unavailable');
        })() as any);

        const res = await POST(makeRequest({ prompt: 'x' }));
        const events = await readSSE(res);
        expect(events).toEqual([{ type: 'error', message: 'Bedrock unavailable' }]);
    });

    it('returns 500 when the request body cannot be parsed', async () => {
        const res = await POST({ json: vi.fn().mockRejectedValue(new Error('bad json')) } as any);
        const body = await res.json();
        expect(res.status).toBe(500);
        expect(body.error).toBe('bad json');
    });

    it('returns a generic 500 message when a non-Error value is thrown', async () => {
        const res = await POST({ json: vi.fn().mockRejectedValue('nope') } as any);
        const body = await res.json();
        expect(res.status).toBe(500);
        expect(body.error).toBe('Internal Server Error');
    });

    it('coerces non-string prior message content to an empty string in history', async () => {
        vi.mocked(invokeTextToSQL).mockReturnValue(singleEventStream([]) as any);
        await POST(makeRequest({
            messages: [{ role: 'user', content: { weird: 'object' } }, { role: 'user', content: 'second' }],
        }));
        expect(invokeTextToSQL).toHaveBeenCalledWith(expect.objectContaining({
            conversationHistory: [{ role: 'user', content: '' }],
        }));
    });

    it('leaves accountIds undefined when filters are present without an accountId', async () => {
        vi.mocked(invokeTextToSQL).mockReturnValue(singleEventStream([]) as any);
        await POST(makeRequest({ prompt: 'x', filters: { region: 'us-east-1' } }));
        expect(invokeTextToSQL).toHaveBeenCalledWith(expect.objectContaining({
            filters: { accountIds: undefined, region: 'us-east-1', resourceType: undefined },
        }));
    });

    it('emits a generic error message when a non-Error value is thrown mid-stream', async () => {
        vi.mocked(invokeTextToSQL).mockReturnValue((async function* () {
            throw 'raw string failure';
        })() as any);

        const res = await POST(makeRequest({ prompt: 'x' }));
        const events = await readSSE(res);
        expect(events).toEqual([{ type: 'error', message: 'Internal Server Error' }]);
    });
});
