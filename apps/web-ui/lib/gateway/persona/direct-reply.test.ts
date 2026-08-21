import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/agent/model-factory', () => ({ createAgentModels: vi.fn() }));

import { createAgentModels } from '@/lib/agent/model-factory';
import { generateDirectReply } from './direct-reply';

function mockModel(content: unknown) {
    const invoke = vi.fn().mockResolvedValue({ content });
    vi.mocked(createAgentModels).mockReturnValue({ main: { invoke } as any, reflector: {} as any });
    return invoke;
}

describe('generateDirectReply', () => {
    beforeEach(() => vi.clearAllMocks());

    it('invokes the main model with the direct system prompt and returns the text', async () => {
        const invoke = mockModel('Hey! What can I help with?');

        const result = await generateDirectReply({ message: 'hi', model: {} as any });

        expect(result).toBe('Hey! What can I help with?');
        const [messages] = invoke.mock.calls[0];
        // Exactly one system turn + one human turn — no conversation history.
        expect(messages).toHaveLength(2);
        expect(messages.filter((m: any) => m._getType() === 'human')).toHaveLength(1);
        expect(messages[0]._getType()).toBe('system');
        expect(messages[0].content).toContain('Conversational Reply Mode');
        expect(messages[1]._getType()).toBe('human');
        expect(messages[1].content).toBe('hi');
    });

    it('appends the channel addendum so the reply is plain text and asks for a full request', async () => {
        const invoke = mockModel('ok');

        await generateDirectReply({ message: 'hi', model: {} as any });

        const [messages] = invoke.mock.calls[0];
        expect(messages[0].content).toContain('Channel Delivery');
        expect(messages[0].content).toContain('no markdown');
        expect(messages[0].content).toContain('complete request as a single message');
    });

    it('truncates very long input to 4000 characters before invoking the model', async () => {
        const invoke = mockModel('ok');

        await generateDirectReply({ message: 'x'.repeat(5000), model: {} as any });

        const [messages] = invoke.mock.calls[0];
        expect(messages[1].content).toBe('x'.repeat(4000));
    });

    it('extracts text from block-array content', async () => {
        mockModel([{ type: 'text', text: 'Hi' }]);

        await expect(generateDirectReply({ message: 'hi', model: {} as any })).resolves.toBe('Hi');
    });

    it('throws when the model returns no usable text, so the caller falls back to a task', async () => {
        mockModel([{ type: 'thinking', thinking: 'hmm' }]);
        await expect(generateDirectReply({ message: 'hi', model: {} as any })).rejects.toThrow(/empty content/);

        mockModel(null);
        await expect(generateDirectReply({ message: 'hi', model: {} as any })).rejects.toThrow(/empty content/);

        mockModel('   ');
        await expect(generateDirectReply({ message: 'hi', model: {} as any })).rejects.toThrow(/empty content/);
    });
});
