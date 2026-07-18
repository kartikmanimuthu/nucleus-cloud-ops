import { describe, it, expect } from 'vitest';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { withUnresolvedToolCallsOnly } from '@/lib/agent/agent-shared';

const ai = (calls: Array<{ id: string; name: string }>) =>
    new AIMessage({ content: '', tool_calls: calls.map(c => ({ ...c, args: {}, type: 'tool_call' as const })) });

describe('withUnresolvedToolCallsOnly', () => {
    it('filters out tool calls that already have ToolMessage results', () => {
        const state = {
            messages: [
                new HumanMessage('go'),
                ai([{ id: 't1', name: 'a' }, { id: 't2', name: 'b' }, { id: 't3', name: 'c' }]),
                new ToolMessage({ tool_call_id: 't2', content: 'Rejected by user' }),
            ],
        };
        const view = withUnresolvedToolCallsOnly(state as any)!;
        const aiMsg = view.messages[1] as AIMessage;
        expect(aiMsg.tool_calls!.map(c => c.id)).toEqual(['t1', 't3']);
        // original state untouched
        expect((state.messages[1] as AIMessage).tool_calls!.length).toBe(3);
    });

    it('returns null when every call is resolved', () => {
        const state = {
            messages: [
                ai([{ id: 't1', name: 'a' }]),
                new ToolMessage({ tool_call_id: 't1', content: 'answer' }),
            ],
        };
        expect(withUnresolvedToolCallsOnly(state as any)).toBeNull();
    });

    it('passes through untouched when nothing is resolved', () => {
        const state = { messages: [ai([{ id: 't1', name: 'a' }])] };
        const view = withUnresolvedToolCallsOnly(state as any)!;
        expect((view.messages[0] as AIMessage).tool_calls!.length).toBe(1);
    });

    it('preserves messages after the last AIMessage in the filtered view', () => {
        const state = {
            messages: [
                new HumanMessage('go'),
                ai([{ id: 't1', name: 'a' }, { id: 't2', name: 'b' }]),
                new ToolMessage({ tool_call_id: 't2', content: 'Rejected by user' }),
            ],
        };
        const view = withUnresolvedToolCallsOnly(state as any)!;
        expect(view.messages).toHaveLength(3);
        expect(view.messages[2]._getType()).toBe('tool');
        const last = view.messages[1] as AIMessage;
        expect(last.tool_calls!.map(c => c.id)).toEqual(['t1']);
    });
});
