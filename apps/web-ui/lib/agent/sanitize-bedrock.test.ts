import { describe, it, expect } from 'vitest';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { sanitizeMessagesForBedrock } from './agent-shared';

describe('sanitizeMessagesForBedrock — reasoning content', () => {
    it('strips a Bedrock reasoningContent block with null text (the crash case)', () => {
        const ai = new AIMessage({
            content: [
                { reasoningContent: { reasoningText: { text: null, signature: 'sig' } } } as any,
                { type: 'text', text: 'Here is the answer.' } as any,
            ],
        });
        const [out] = sanitizeMessagesForBedrock([new HumanMessage('hi'), ai]).slice(1);
        expect(Array.isArray(out.content)).toBe(true);
        const blocks = out.content as any[];
        expect(blocks.some((b) => 'reasoningContent' in b)).toBe(false);
        expect(blocks).toEqual([{ type: 'text', text: 'Here is the answer.' }]);
    });

    it('strips normalized thinking/reasoning blocks but keeps text + tool_use', () => {
        const ai = new AIMessage({
            content: [
                { type: 'thinking', thinking: 'let me think' } as any,
                { type: 'text', text: 'calling tool' } as any,
                { type: 'tool_use', id: 't1', name: 'do_it', input: {} } as any,
            ],
            tool_calls: [{ id: 't1', name: 'do_it', args: {}, type: 'tool_call' }],
        });
        const out = sanitizeMessagesForBedrock([ai, new ToolMessage({ content: 'ok', tool_call_id: 't1' })]);
        const cleanedAi = out[0];
        const blocks = cleanedAi.content as any[];
        expect(blocks.some((b) => b.type === 'thinking')).toBe(false);
        expect(blocks.some((b) => b.type === 'text')).toBe(true);
        expect(blocks.some((b) => b.type === 'tool_use')).toBe(true);
        // tool result still re-emitted immediately after its owning AI message
        expect(out[1]._getType()).toBe('tool');
        // tool_calls metadata preserved on the clone
        expect((cleanedAi as AIMessage).tool_calls?.[0]?.id).toBe('t1');
    });

    it('leaves messages without reasoning blocks untouched (same reference)', () => {
        const ai = new AIMessage({ content: 'plain answer' });
        const input = [new HumanMessage('q'), ai];
        const out = sanitizeMessagesForBedrock(input);
        expect(out[1]).toBe(ai);
    });

    it('rewrites a reasoning-only AI message (empty after strip, no tool_calls) to a non-empty placeholder', () => {
        const reasoningOnly = new AIMessage({
            content: [
                { reasoningContent: { reasoningText: { text: null, signature: 'sig' } } } as any,
            ],
        });
        const out = sanitizeMessagesForBedrock([
            new HumanMessage('first question'),
            reasoningOnly,
            new HumanMessage('Proceed.'),
        ]);

        // No AI message may leave sanitize with empty content.
        const emptyAi = out.find((m) => {
            if (m._getType() !== 'ai') return false;
            const c = m.content;
            if (typeof c === 'string') return c.trim() === '';
            return Array.isArray(c) && c.length === 0;
        });
        expect(emptyAi).toBeUndefined();

        // The rewritten message is present, in place, with the placeholder text.
        expect(out).toHaveLength(3);
        expect(out[1]._getType()).toBe('ai');
        expect(out[1].content).toBe('(reasoning omitted)');
    });

    it('preserves message count and role order (no consecutive same-role pair)', () => {
        const input = [
            new HumanMessage('q1'),
            new AIMessage({ content: [{ reasoningContent: { reasoningText: { text: null } } } as any] }),
            new HumanMessage('Proceed.'),
            new AIMessage({ content: 'the real answer' }),
            new HumanMessage('q2'),
        ];
        const out = sanitizeMessagesForBedrock(input);

        expect(out.map((m) => m._getType())).toEqual(['human', 'ai', 'human', 'ai', 'human']);
        for (let i = 1; i < out.length; i++) {
            expect(out[i]._getType()).not.toBe(out[i - 1]._getType());
        }
    });

    it('does NOT rewrite an AI message that is empty-after-strip but has tool_calls', () => {
        const toolTurn = new AIMessage({
            content: [
                { reasoningContent: { reasoningText: { text: null } } } as any,
                { type: 'tool_use', id: 't1', name: 'do_it', input: {} } as any,
            ],
            tool_calls: [{ id: 't1', name: 'do_it', args: {}, type: 'tool_call' }],
        });
        const out = sanitizeMessagesForBedrock([
            toolTurn,
            new ToolMessage({ content: 'ok', tool_call_id: 't1' }),
        ]);

        const ai = out[0] as AIMessage;
        expect(ai._getType()).toBe('ai');
        expect(ai.content).not.toBe('(reasoning omitted)');           // untouched, not rewritten
        expect(Array.isArray(ai.content)).toBe(true);
        expect((ai.content as any[]).some((b) => b.type === 'tool_use')).toBe(true);
        expect(ai.tool_calls?.[0]?.id).toBe('t1');
        // tool result still re-emitted immediately after its owning AI message
        expect(out[1]._getType()).toBe('tool');
        expect((out[1] as any).tool_call_id).toBe('t1');
    });

    it('leaves an AI message untouched when it has a tool_use content block but no normalized tool_calls', () => {
        const toolBlockOnly = new AIMessage({
            content: [
                { reasoningContent: { reasoningText: { text: null } } } as any,
                { type: 'tool_use', id: 't9', name: 'do_it', input: {} } as any,
            ],
            // no tool_calls — the checkpoint-round-trip divergence the file warns about
        });
        const out = sanitizeMessagesForBedrock([
            toolBlockOnly,
            new ToolMessage({ content: 'ok', tool_call_id: 't9' }),
        ]);
        const ai = out[0] as AIMessage;
        expect(ai.content).not.toBe('(reasoning omitted)');
        expect(Array.isArray(ai.content)).toBe(true);
        expect((ai.content as any[]).some((b) => b.type === 'tool_use')).toBe(true);
        expect(out[1]._getType()).toBe('tool');
    });
});
