import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/agent/model-factory', () => ({ createAgentModels: vi.fn() }));
vi.mock('@/lib/agent/prompt-templates', () => ({ buildDirectSystemPrompt: vi.fn(() => 'You are a helpful assistant.') }));
vi.mock('@/lib/agent/persistence', () => ({
    getChatHistory: vi.fn().mockResolvedValue({ addMessages: vi.fn().mockResolvedValue(undefined) }),
}));

import { createAgentModels } from '@/lib/agent/model-factory';
import { getChatHistory } from '@/lib/agent/persistence';
import { respondDirect } from './direct-chat';

const BASE_PARAMS = {
    resolvedModel: { provider: 'bedrock' } as any,
    threadId: 't1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    releaseLock: vi.fn(),
};

async function* fakeStream(chunks: Array<{ content: string }>) {
    for (const c of chunks) yield c;
}

async function readSSE(res: Response): Promise<string> {
    return res.text();
}

describe('respondDirect (non-streaming)', () => {
    beforeEach(() => vi.clearAllMocks());

    it('invokes the model, persists the exchange, and releases the lock', async () => {
        const invoke = vi.fn().mockResolvedValue({ content: 'Hi there!' });
        vi.mocked(createAgentModels).mockReturnValue({ main: { invoke, stream: vi.fn() } } as any);
        const releaseLock = vi.fn();
        const chatHistory = { addMessages: vi.fn().mockResolvedValue(undefined) };
        vi.mocked(getChatHistory).mockResolvedValue(chatHistory as any);

        const res = await respondDirect({
            ...BASE_PARAMS, releaseLock,
            messages: [{ role: 'user', content: 'Hello' }],
            stream: false,
        });
        const body = await res.json();

        expect(body).toEqual({ role: 'assistant', content: 'Hi there!' });
        expect(chatHistory.addMessages).toHaveBeenCalledWith(
            'tenant-1', 'user-1', 't1',
            [{ role: 'human', content: 'Hello' }, { role: 'ai', content: 'Hi there!' }],
            'Hello',
        );
        expect(releaseLock).toHaveBeenCalled();
    });

    it('releases the lock even when the model invocation throws', async () => {
        const invoke = vi.fn().mockRejectedValue(new Error('model unavailable'));
        vi.mocked(createAgentModels).mockReturnValue({ main: { invoke, stream: vi.fn() } } as any);
        const releaseLock = vi.fn();

        await expect(respondDirect({
            ...BASE_PARAMS, releaseLock,
            messages: [{ role: 'user', content: 'Hello' }],
            stream: false,
        })).rejects.toThrow('model unavailable');
        expect(releaseLock).toHaveBeenCalled();
    });

    it('builds history from the last 12 user/assistant messages, dropping blank ones', async () => {
        const invoke = vi.fn().mockResolvedValue({ content: 'ok' });
        vi.mocked(createAgentModels).mockReturnValue({ main: { invoke, stream: vi.fn() } } as any);

        const messages = [
            { role: 'system', content: 'ignored' },
            { role: 'user', content: '' },
            { role: 'user', content: 'First' },
            { role: 'assistant', content: 'Reply' },
            { role: 'user', content: 'Second' },
        ];
        await respondDirect({ ...BASE_PARAMS, messages, stream: false });

        const lcInput = invoke.mock.calls[0][0];
        // [SystemMessage, HumanMessage("First"), AIMessage("Reply"), HumanMessage("Second")]
        expect(lcInput).toHaveLength(4);
        expect(lcInput[3].content).toBe('Second');
    });

    it('derives text from message parts when content is not a plain string', async () => {
        const invoke = vi.fn().mockResolvedValue({ content: 'ok' });
        vi.mocked(createAgentModels).mockReturnValue({ main: { invoke, stream: vi.fn() } } as any);

        await respondDirect({
            ...BASE_PARAMS, stream: false,
            messages: [{ role: 'user', content: '', parts: [{ type: 'text', text: 'From parts' }] }],
        });

        const lcInput = invoke.mock.calls[0][0];
        expect(lcInput[1].content).toBe('From parts');
    });

    it('falls back to "New Chat" as the session title when there is no user text', async () => {
        const invoke = vi.fn().mockResolvedValue({ content: 'ok' });
        vi.mocked(createAgentModels).mockReturnValue({ main: { invoke, stream: vi.fn() } } as any);
        const chatHistory = { addMessages: vi.fn().mockResolvedValue(undefined) };
        vi.mocked(getChatHistory).mockResolvedValue(chatHistory as any);

        await respondDirect({ ...BASE_PARAMS, stream: false, messages: [{ role: 'assistant', content: 'hi' }] });
        expect(chatHistory.addMessages).toHaveBeenCalledWith('tenant-1', 'user-1', 't1', expect.any(Array), 'New Chat');
    });

    it('does not fail the request when persistence throws', async () => {
        const invoke = vi.fn().mockResolvedValue({ content: 'ok' });
        vi.mocked(createAgentModels).mockReturnValue({ main: { invoke, stream: vi.fn() } } as any);
        vi.mocked(getChatHistory).mockRejectedValue(new Error('DB down'));

        const res = await respondDirect({ ...BASE_PARAMS, messages: [{ role: 'user', content: 'hi' }], stream: false });
        const body = await res.json();
        expect(body.content).toBe('ok');
    });
});

describe('respondDirect (streaming)', () => {
    beforeEach(() => vi.clearAllMocks());

    it('streams start, text deltas, text-end, and finish, then persists and releases the lock', async () => {
        const stream = vi.fn().mockResolvedValue(fakeStream([{ content: 'Hello ' }, { content: 'world' }]));
        vi.mocked(createAgentModels).mockReturnValue({ main: { invoke: vi.fn(), stream } } as any);
        const releaseLock = vi.fn();
        const chatHistory = { addMessages: vi.fn().mockResolvedValue(undefined) };
        vi.mocked(getChatHistory).mockResolvedValue(chatHistory as any);

        const res = await respondDirect({
            ...BASE_PARAMS, releaseLock,
            messages: [{ role: 'user', content: 'Hi' }],
            stream: true,
        });
        const text = await readSSE(res);

        expect(text).toContain('"type":"start"');
        expect(text).toContain('Hello ');
        expect(text).toContain('world');
        expect(text).toContain('"type":"finish"');
        expect(chatHistory.addMessages).toHaveBeenCalledWith(
            'tenant-1', 'user-1', 't1',
            [{ role: 'human', content: 'Hi' }, { role: 'ai', content: 'Hello world' }],
            'Hi',
        );
        expect(releaseLock).toHaveBeenCalled();
    });

    it('closes cleanly with no error text on an aborted stream, and skips persistence when nothing was said', async () => {
        const stream = vi.fn().mockResolvedValue((async function* () {
            const err = new Error('The user aborted a request.');
            err.name = 'AbortError';
            throw err;
        })());
        vi.mocked(createAgentModels).mockReturnValue({ main: { invoke: vi.fn(), stream } } as any);
        const chatHistory = { addMessages: vi.fn().mockResolvedValue(undefined) };
        vi.mocked(getChatHistory).mockResolvedValue(chatHistory as any);

        const res = await respondDirect({ ...BASE_PARAMS, messages: [{ role: 'user', content: 'Hi' }], stream: true });
        const text = await readSSE(res);

        expect(text).not.toContain('Reply failed');
        expect(chatHistory.addMessages).not.toHaveBeenCalled();
    });

    it('appends a visible error message and still finishes on a non-abort stream failure', async () => {
        const stream = vi.fn().mockResolvedValue((async function* () {
            yield { content: 'Partial ' };
            throw new Error('Bedrock throttled');
        })());
        vi.mocked(createAgentModels).mockReturnValue({ main: { invoke: vi.fn(), stream } } as any);
        const chatHistory = { addMessages: vi.fn().mockResolvedValue(undefined) };
        vi.mocked(getChatHistory).mockResolvedValue(chatHistory as any);

        const res = await respondDirect({ ...BASE_PARAMS, messages: [{ role: 'user', content: 'Hi' }], stream: true });
        const text = await readSSE(res);

        expect(text).toContain('Reply failed: Bedrock throttled');
        expect(text).toContain('"type":"finish"');
        expect(chatHistory.addMessages).toHaveBeenCalledWith(
            'tenant-1', 'user-1', 't1',
            expect.arrayContaining([expect.objectContaining({ role: 'ai', content: expect.stringContaining('Partial') })]),
            'Hi',
        );
    });

    it('ignores empty deltas from the model stream', async () => {
        const stream = vi.fn().mockResolvedValue(fakeStream([{ content: '' }, { content: 'real text' }]));
        vi.mocked(createAgentModels).mockReturnValue({ main: { invoke: vi.fn(), stream } } as any);

        const res = await respondDirect({ ...BASE_PARAMS, messages: [{ role: 'user', content: 'Hi' }], stream: true });
        const text = await readSSE(res);
        expect(text).toContain('real text');
    });

});
