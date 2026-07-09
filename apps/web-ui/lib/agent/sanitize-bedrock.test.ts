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
});
