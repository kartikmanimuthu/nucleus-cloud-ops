/**
 * Unit tests for agent-shared.ts utility functions:
 * - sanitizeMessagesForBedrock: ensures every tool_call has a matched tool_result
 * - getRecentMessages:          trims context window without producing orphans
 * - executionOutput reducer:    replaces instead of accumulating
 */

import { describe, it, expect } from 'vitest';
import { AIMessage, HumanMessage, ToolMessage, BaseMessage } from '@langchain/core/messages';
import { sanitizeMessagesForBedrock, getRecentMessages, graphState, tagMessagePhase, computeReflectionStall, REFLECTION_STALL_LIMIT, extractTextContent, critiqueVerdict, buildToolExecutionLog } from '../../lib/agent/agent-shared';

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

    it('keeps a tool_result adjacent to its tool_use when an intervening message separated them', () => {
        // Reproduces the production ValidationException: getRecentMessages' role-alternation
        // formatter can inject a HumanMessage("Proceed.") between an AI tool_use and its
        // ToolMessage. Bedrock requires the toolResult to IMMEDIATELY follow the toolUse —
        // "answered somewhere" is not enough.
        const ai = makeAIWithToolCalls([{ id: 'tooluse_7eO4', name: 'execute_command' }]);
        const tool = makeToolResult('tooluse_7eO4', 'execute_command');
        const input = [ai, new HumanMessage('Proceed.'), tool];

        const result = sanitizeMessagesForBedrock(input);

        // The AI tool_use must be immediately followed by its toolResult.
        const aiIdx = result.findIndex(
            m => m._getType() === 'ai' && (m as AIMessage).tool_calls?.some(tc => tc.id === 'tooluse_7eO4')
        );
        expect(aiIdx).toBeGreaterThanOrEqual(0);
        const next = result[aiIdx + 1];
        expect(next._getType()).toBe('tool');
        expect((next as any).tool_call_id).toBe('tooluse_7eO4');
        // Exactly one tool_result for the id (no duplicate, no dropped result).
        const matches = result.filter(m => m._getType() === 'tool' && (m as any).tool_call_id === 'tooluse_7eO4');
        expect(matches).toHaveLength(1);
    });

    it('drops an orphaned tool_result whose tool_use is not in the window', () => {
        // A ToolMessage with no owning AI tool_use anywhere is invalid for Bedrock
        // (toolResult without toolUse) and must not be forwarded.
        const orphan = makeToolResult('tc-ghost', 'ghost_tool');
        const input = [new HumanMessage('Go'), orphan, new AIMessage('done')];

        const result = sanitizeMessagesForBedrock(input);

        expect(result.some(m => m._getType() === 'tool')).toBe(false);
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
// tagMessagePhase — phase tagging for exact history reconstruction
// ---------------------------------------------------------------------------

describe('tagMessagePhase', () => {
    it('tags an AI message with the originating agent phase under response_metadata', () => {
        const msg = new AIMessage({ content: 'reflection output' });
        const tagged = tagMessagePhase(msg, 'reflection');

        expect((tagged as any).response_metadata?.agentPhase).toBe('reflection');
        // Returns the same instance (mutates in place) so node return values stay simple.
        expect(tagged).toBe(msg);
    });

    it('preserves existing response_metadata (e.g. provider usage) when tagging', () => {
        const msg = new AIMessage({ content: 'x' });
        (msg as any).response_metadata = { usage: { tokens: 42 } };

        tagMessagePhase(msg, 'execution');

        expect((msg as any).response_metadata.usage).toEqual({ tokens: 42 });
        expect((msg as any).response_metadata.agentPhase).toBe('execution');
    });

    it('round-trips through a JSON serialize/parse like the checkpointer does', () => {
        const tagged = tagMessagePhase(new AIMessage({ content: 'final answer' }), 'final');
        const revived = JSON.parse(JSON.stringify({ response_metadata: (tagged as any).response_metadata }));
        expect(revived.response_metadata.agentPhase).toBe('final');
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

describe('extractTextContent', () => {
    it('returns a plain string unchanged', () => {
        expect(extractTextContent('hello world')).toBe('hello world');
    });

    it('joins Bedrock text-delta blocks into the original prose (not "[object Object]")', () => {
        // The runtime bug: `response.content as string` on this array yielded
        // "[object Object],[object Object]" and blew up .match()/.toLowerCase().
        const blocks = [
            { type: 'text', text: '{"analysis":' },
            { type: 'text', text: ' "looks good",' },
            { type: 'text', text: ' "isComplete": true}' },
        ];
        const out = extractTextContent(blocks);
        expect(out).toBe('{"analysis": "looks good", "isComplete": true}');
        expect(out).not.toContain('[object Object]');
        expect(() => JSON.parse(out)).not.toThrow();
    });

    it('keeps only text blocks, dropping tool_use blocks', () => {
        const blocks = [
            { type: 'text', text: 'thinking' },
            { type: 'tool_use', id: 't1', name: 'foo', input: {} },
        ];
        expect(extractTextContent(blocks)).toBe('thinking');
    });

    it('returns a usable string (never throws) for empty / null content', () => {
        expect(extractTextContent([])).toBe('');
        expect(extractTextContent(null)).toBe('');
        expect(extractTextContent(undefined)).toBe('');
    });

    it('produces output that supports the string ops the reflector calls', () => {
        const blocks = [{ type: 'text', text: 'Task Complete' }];
        const out = extractTextContent(blocks);
        // These are exactly the calls that threw at planning-agent.ts:476 / :159
        expect(out.toLowerCase()).toContain('task complete');
        expect(out.indexOf('{')).toBe(-1);
        expect(() => out.match(/\[[\s\S]*\]/)).not.toThrow();
    });
});

describe('critiqueVerdict', () => {
    it('accepts when the critique contains COMPLETE', () => {
        expect(critiqueVerdict('COMPLETE')).toBe('accept');
        expect(critiqueVerdict('The answer is good. COMPLETE')).toBe('accept');
    });

    it('accepts when the critique is empty — an empty critique must never drive a revision loop', () => {
        // Live failure: reflector burned its whole output budget on a
        // reasoning_content block (stopReason max_tokens) → no text → the agent
        // received "[REFLECTION FEEDBACK]" with an empty issue list and looped.
        expect(critiqueVerdict('')).toBe('accept');
        expect(critiqueVerdict('   \n  ')).toBe('accept');
    });

    it('revises when the critique lists real issues', () => {
        expect(critiqueVerdict('- Missing --output json on the CLI call')).toBe('revise');
    });
});

describe('buildToolExecutionLog', () => {
    it('includes tool results from ALL iterations, not just the current one', () => {
        // Live failure: tools ran in iterations 1-2, reflection happened at
        // iteration 3 → the per-iteration filter produced an empty log and the
        // reflector falsely accused the agent of fabricating tool data.
        const results = [
            { toolName: 'searchJiraIssuesUsingJql', output: '{"issues":[...]}', isError: false, iterationIndex: 1 },
            { toolName: 'getJiraIssue', output: '{"key":"DEVCHNMGM-817"}', isError: false, iterationIndex: 2 },
        ];
        const log = buildToolExecutionLog(results);
        expect(log).toContain('searchJiraIssuesUsingJql');
        expect(log).toContain('getJiraIssue');
        expect(log).toContain('<TOOL_EXECUTION_LOG>');
    });

    it('returns empty string when no tools were executed', () => {
        expect(buildToolExecutionLog([])).toBe('');
        expect(buildToolExecutionLog(undefined)).toBe('');
    });

    it('marks errored tool calls', () => {
        const log = buildToolExecutionLog([
            { toolName: 'execute_command', output: 'Command failed', isError: true, iterationIndex: 1 },
        ]);
        expect(log).toContain('ERROR');
    });
});

describe('computeReflectionStall', () => {
    it('does not stall on the first reflection with an issue', () => {
        const r = computeReflectionStall('AWS CLI missing --output json', undefined, 0);
        expect(r.stallCount).toBe(0);
        expect(r.stalled).toBe(false);
    });

    it('resets the count when the issue changes between reflections', () => {
        const r = computeReflectionStall('new different issue', 'old issue', 1);
        expect(r.stallCount).toBe(0);
        expect(r.stalled).toBe(false);
    });

    it('resets the count when the current reflection reports no issues', () => {
        const r = computeReflectionStall('None', 'some issue', 1);
        expect(r.stallCount).toBe(0);
        expect(r.stalled).toBe(false);
    });

    it('increments the count when the same blocking issue repeats', () => {
        const r = computeReflectionStall('same issue', 'same issue', 0);
        expect(r.stallCount).toBe(1);
        expect(r.stalled).toBe(false);
    });

    it('flags stalled once the same issue persists to the limit', () => {
        const r = computeReflectionStall('same issue', 'same issue', REFLECTION_STALL_LIMIT - 1);
        expect(r.stallCount).toBe(REFLECTION_STALL_LIMIT);
        expect(r.stalled).toBe(true);
    });

    it('treats empty-string issues as no issue (no false stall)', () => {
        const r = computeReflectionStall('', '', 1);
        expect(r.stallCount).toBe(0);
        expect(r.stalled).toBe(false);
    });
});
