/**
 * Unit tests for agent-shared.ts utility functions:
 * - sanitizeMessagesForBedrock: ensures every tool_call has a matched tool_result
 * - getRecentMessages:          trims context window without producing orphans
 * - executionOutput reducer:    replaces instead of accumulating
 */

import { describe, it, expect } from 'vitest';
import { AIMessage, HumanMessage, ToolMessage, BaseMessage } from '@langchain/core/messages';
import { sanitizeMessagesForBedrock, getRecentMessages, graphState } from '../../lib/agent/agent-shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeAIWithToolCalls(toolCalls: Array<{ id: string; name: string }>) {
    return new AIMessage({
        content: '',
        tool_calls: toolCalls.map(tc => ({
            id: tc.id,
            name: tc.name,
            args: {},
            type: 'tool_call' as const,
        })),
    });
}

function makeToolResult(toolCallId: string, name = 'some_tool') {
    return new ToolMessage({
        content: `Result for ${toolCallId}`,
        tool_call_id: toolCallId,
        name,
    });
}

// ---------------------------------------------------------------------------
// sanitizeMessagesForBedrock
// ---------------------------------------------------------------------------

describe('sanitizeMessagesForBedrock', () => {
    it('passes through a valid AI → ToolMessage pair unchanged', () => {
        const ai = makeAIWithToolCalls([{ id: 'tc-1', name: 'list_buckets' }]);
        const tool = makeToolResult('tc-1', 'list_buckets');
        const input = [new HumanMessage('Go'), ai, tool];

        const result = sanitizeMessagesForBedrock(input);

        expect(result).toHaveLength(3);
        expect(result[2]._getType()).toBe('tool');
    });

    it('inserts a synthetic ToolMessage for an orphaned tool_call', () => {
        const ai = makeAIWithToolCalls([{ id: 'tc-orphan', name: 'get_creds' }]);
        // No ToolMessage follows — simulates the truncation bug
        const input = [new HumanMessage('Go'), ai];

        const result = sanitizeMessagesForBedrock(input);

        // Should now be 3: Human, AI, synthetic Tool
        expect(result).toHaveLength(3);
        const synth = result[2] as ToolMessage;
        expect(synth._getType()).toBe('tool');
        expect((synth as any).tool_call_id).toBe('tc-orphan');
        expect(synth.content).toContain('unavailable');
    });

    it('inserts synthetic results only for un-matched tool_calls, not already-matched ones', () => {
        const ai = makeAIWithToolCalls([
            { id: 'tc-a', name: 'tool_a' },
            { id: 'tc-b', name: 'tool_b' },
        ]);
        const toolA = makeToolResult('tc-a', 'tool_a');
        // tc-b has no result — orphaned
        const input = [new HumanMessage('Go'), ai, toolA];

        const result = sanitizeMessagesForBedrock(input);

        // Human + AI + toolA-result + synthetic-for-tc-b
        expect(result).toHaveLength(4);
        const toolMessages = result.filter(m => m._getType() === 'tool') as ToolMessage[];
        expect(toolMessages).toHaveLength(2);
        const synthMsg = toolMessages.find(m => (m as any).tool_call_id === 'tc-b');
        expect(synthMsg).toBeDefined();
        expect(synthMsg!.content).toContain('unavailable');
    });

    it('handles multiple consecutive tool-call/result groups correctly', () => {
        const ai1 = makeAIWithToolCalls([{ id: 'tc-1', name: 'tool_1' }]);
        const tool1 = makeToolResult('tc-1', 'tool_1');
        const humanNext = new HumanMessage('Next step');
        const ai2 = makeAIWithToolCalls([{ id: 'tc-2', name: 'tool_2' }]);
        const tool2 = makeToolResult('tc-2', 'tool_2');

        const input = [new HumanMessage('Start'), ai1, tool1, humanNext, ai2, tool2];
        const result = sanitizeMessagesForBedrock(input);

        // Nothing should be inserted — all pairs are matched
        expect(result).toHaveLength(6);
    });

    it('returns empty array for empty input', () => {
        expect(sanitizeMessagesForBedrock([])).toHaveLength(0);
    });

    it('passes through AI messages without tool_calls untouched', () => {
        const msgs = [
            new HumanMessage('Hi'),
            new AIMessage('Hello there!'),
        ];
        const result = sanitizeMessagesForBedrock(msgs);
        expect(result).toHaveLength(2);
        expect(result[1].content).toBe('Hello there!');
    });
});

// ---------------------------------------------------------------------------
// getRecentMessages — window boundary & orphan protection
// ---------------------------------------------------------------------------

describe('getRecentMessages', () => {
    it('returns all messages when total is below maxMessages', () => {
        const msgs = [
            new HumanMessage('task'),
            new AIMessage('ok'),
        ];
        const result = getRecentMessages(msgs, 25);
        expect(result.length).toBeLessThanOrEqual(3); // At most 3 (first msg may be prepended)
        // Must include the task HumanMessage
        expect(result.some(m => m._getType() === 'human')).toBe(true);
    });

    it('does not produce orphaned ToolMessages at the start of window', () => {
        // Build 50 messages: Human, then alternating AI-with-tool + ToolResult pairs
        const msgs: BaseMessage[] = [new HumanMessage('start task')];
        for (let i = 0; i < 24; i++) {
            const ai = makeAIWithToolCalls([{ id: `tc-${i}`, name: `tool_${i}` }]);
            const tool = makeToolResult(`tc-${i}`, `tool_${i}`);
            msgs.push(ai, tool);
        }

        const result = getRecentMessages(msgs, 15);

        // The first element must not be a ToolMessage (that would mean its AI parent was dropped)
        expect(result[0]._getType()).not.toBe('tool');
    });

    it('filters out messages with empty string content', () => {
        const msgs = [
            new HumanMessage('task'),
            new AIMessage(''),   // should be filtered (no tool_calls)
            new AIMessage('real answer'),
        ];
        const result = getRecentMessages(msgs, 25);
        const emptyAI = result.find(m => m._getType() === 'ai' && m.content === '');
        expect(emptyAI).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// executionOutput reducer — replace semantics
// ---------------------------------------------------------------------------

describe('executionOutput graphState reducer', () => {
    const channel = graphState.executionOutput!;
    const reducer = ('reducer' in channel ? channel.reducer : channel.value) as (x: string, y: string) => string;

    it('returns the new value when y is non-empty', () => {
        const result = reducer('old output', 'new output');
        expect(result).toBe('new output');
    });

    it('returns the existing value when y is empty string', () => {
        const result = reducer('existing', '');
        expect(result).toBe('existing');
    });

    it('does NOT concatenate old and new (no unbounded accumulation)', () => {
        const result = reducer('old', 'new');
        expect(result).not.toContain('old');
    });

    it('initialises to empty string', () => {
        const defaultFn = graphState.executionOutput?.default as () => string;
        expect(defaultFn()).toBe('');
    });
});
