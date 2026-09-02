import { describe, it, expect } from 'vitest';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { sanitizeMessagesForBedrock, repairEmptyAiContent, stripReasoningFromMessages } from './agent-shared';

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

describe('stripReasoningFromMessages — the deep-agent replay guard', () => {
    // Production failure this exists for:
    //   ValidationException: The model returned the following errors:
    //   messages.1.content.0.thinking.signature: Field required
    // A thinking block is replayable only while it carries the signature the model
    // issued with it. The checkpoint round-trip does not keep that field, so a stored
    // turn replays without it and Bedrock refuses the call.
    it('strips a replayed thinking block that lost its signature', () => {
        const ai = new AIMessage({
            content: [
                { type: 'thinking', thinking: 'let me consider…' } as any,
                { type: 'text', text: 'Here is the answer.' } as any,
            ],
        });

        const out = stripReasoningFromMessages([ai]);

        expect(out[0].content).toEqual([{ type: 'text', text: 'Here is the answer.' }]);
    });

    it('strips a thinking block even when the signature is present', () => {
        // Dropping it unconditionally is the point: the signature cannot be trusted to
        // survive the next round-trip either.
        const ai = new AIMessage({
            content: [
                { type: 'thinking', thinking: 'reasoning', signature: 'abc123' } as any,
                { type: 'text', text: 'answer' } as any,
            ],
        });
        expect(stripReasoningFromMessages([ai])[0].content).toEqual([
            { type: 'text', text: 'answer' },
        ]);
    });

    it('strips the raw Bedrock Converse shape too', () => {
        const ai = new AIMessage({
            content: [
                { reasoningContent: { reasoningText: { text: 'scratchpad' } } } as any,
                { type: 'text', text: 'answer' } as any,
            ],
        });
        expect(stripReasoningFromMessages([ai])[0].content).toEqual([
            { type: 'text', text: 'answer' },
        ]);
    });

    it('keeps the tool calls on a message whose reasoning was stripped', () => {
        // Losing these would silently break the agent loop.
        const ai = new AIMessage({
            content: [{ type: 'thinking', thinking: 'which tool?' } as any],
            tool_calls: [{ name: 'get_blast_radius', args: { resourceId: 'db-1' }, id: 'call_1' }],
        });

        const out = stripReasoningFromMessages([ai])[0] as AIMessage;

        expect(out.tool_calls).toHaveLength(1);
        expect(out.tool_calls?.[0].id).toBe('call_1');
    });

    it('leaves messages without reasoning untouched', () => {
        const human = new HumanMessage('hello');
        const ai = new AIMessage({ content: [{ type: 'text', text: 'hi' } as any] });
        const out = stripReasoningFromMessages([human, ai]);
        expect(out[0]).toBe(human);
        expect(out[1]).toBe(ai);
    });

    // The deep agent composes the two: stripping can empty a reasoning-only turn, and
    // Bedrock rejects a message with no content — so repair must run after strip.
    it('composes with repairEmptyAiContent so a reasoning-only turn is not left empty', () => {
        const ai = new AIMessage({
            content: [{ type: 'thinking', thinking: 'only reasoning here' } as any],
        });

        const out = repairEmptyAiContent(stripReasoningFromMessages([ai]));

        expect(out[0].content).toEqual([{ type: 'text', text: '(reasoning omitted)' }]);
    });
});

describe('deep agent replaying the exact production thread that failed', () => {
    // Reproduces the message list behind:
    //   [DeepStream] error: ValidationException: The model returned the following
    //   errors: messages.1.content.0.thinking.signature: Field required
    //
    // Note the indices the error names: message 1 (the assistant turn), content 0 (a
    // thinking block). That is a stored turn being replayed from the checkpoint, and
    // the block no longer carries the signature Bedrock demands. This asserts the
    // deep middleware's composition — strip, then repair — leaves nothing Bedrock
    // can reject, while keeping the tool call the loop depends on.
    const replayedThread = () => [
        new HumanMessage('Check all ECS services across my selected accounts'),
        // messages.1 — content.0 is the thinking block with no signature
        new AIMessage({
            content: [
                { type: 'thinking', thinking: 'I should fetch credentials first.' } as any,
                { type: 'text', text: 'Let me get credentials.' } as any,
            ],
            tool_calls: [
                { name: 'get_aws_credentials', args: { accountId: '970547372609' }, id: 'call_creds' },
            ],
        }),
        new ToolMessage({ content: '{"success":true}', tool_call_id: 'call_creds' }),
        new HumanMessage('Check all ECS services across my selected accounts'),
    ];

    // Exactly what deep-agent.ts's RepairEmptyAiContent middleware now runs.
    const deepMiddleware = (msgs: any[]) => repairEmptyAiContent(stripReasoningFromMessages(msgs));

    it('leaves no reasoning block anywhere in the replayed thread', () => {
        const out = deepMiddleware(replayedThread());

        const reasoningBlocks = out.flatMap((m) =>
            Array.isArray(m.content)
                ? (m.content as any[]).filter(
                      (b) => b?.type === 'thinking' || b?.type === 'reasoning' || 'reasoningContent' in (b ?? {}),
                  )
                : [],
        );

        expect(reasoningBlocks).toEqual([]);
    });

    it('keeps the assistant turn answerable — text kept, tool call intact', () => {
        const out = deepMiddleware(replayedThread());
        const assistant = out[1] as AIMessage;

        expect(assistant.content).toEqual([{ type: 'text', text: 'Let me get credentials.' }]);
        expect(assistant.tool_calls?.[0].id).toBe('call_creds');
    });

    it('preserves the thread shape, so role alternation and the tool result still line up', () => {
        const out = deepMiddleware(replayedThread());

        expect(out.map((m) => m._getType())).toEqual(['human', 'ai', 'tool', 'human']);
        expect((out[2] as ToolMessage).tool_call_id).toBe('call_creds');
    });

    it('survives a thinking-only assistant turn, which strip alone would leave empty', () => {
        const thread = [
            new HumanMessage('go'),
            new AIMessage({ content: [{ type: 'thinking', thinking: 'thinking only' } as any] }),
        ];

        const out = deepMiddleware(thread);

        // Empty content is its own Bedrock rejection; repair must catch what strip empties.
        expect(out[1].content).toEqual([{ type: 'text', text: '(reasoning omitted)' }]);
    });
});

describe('repairEmptyAiContent — the deep-agent guard', () => {
    it('rewrites an AI message left with no content after a checkpoint round-trip', () => {
        // What Bedrock rejected: "The content field in the Message object at
        // messages.37 is empty."
        const out = repairEmptyAiContent([new AIMessage({ content: [] })]);
        expect(out[0].content).toEqual([{ type: 'text', text: '(reasoning omitted)' }]);
    });

    it('rewrites content that is only whitespace text blocks', () => {
        const out = repairEmptyAiContent([
            new AIMessage({ content: [{ type: 'text', text: '   ' } as any] }),
        ]);
        expect(out[0].content).toEqual([{ type: 'text', text: '(reasoning omitted)' }]);
    });

    it('keeps an empty-content AI message that carries tool calls, and its tool calls', () => {
        // Valid for Bedrock: the toolUse block IS the content.
        const ai = new AIMessage({
            content: '',
            tool_calls: [{ id: 't1', name: 'aws_read', args: {} }],
        });
        const out = repairEmptyAiContent([ai]);
        expect(out[0]).toBe(ai);
        expect((out[0] as AIMessage).tool_calls).toHaveLength(1);
    });

    it('preserves tool calls when it does rewrite', () => {
        const ai = new AIMessage({ content: [], tool_calls: [] });
        const out = repairEmptyAiContent([ai]) as AIMessage[];
        expect(out[0].content).toEqual([{ type: 'text', text: '(reasoning omitted)' }]);
        expect(out[0].tool_calls).toEqual([]);
    });

    it('survives a deepagents message tagged output_version v1 (the constructor crash)', () => {
        // @langchain/core moves `content` into `contentBlocks` on this flag and then
        // calls .push on it — a string content threw
        // "initParams.contentBlocks.push is not a function" mid-run.
        const ai = new AIMessage({
            content: [],
            response_metadata: { output_version: 'v1' } as any,
        });
        expect(() => repairEmptyAiContent([ai])).not.toThrow();
        const out = repairEmptyAiContent([ai]);
        expect(out[0].content).not.toEqual([]);
    });

    it('returns human, tool and non-empty AI messages untouched', () => {
        const human = new HumanMessage('check ecs');
        const tool = new ToolMessage({ content: 'ok', tool_call_id: 't1' });
        const ai = new AIMessage({ content: 'here is the report' });
        const out = repairEmptyAiContent([human, tool, ai]);
        expect(out[0]).toBe(human);
        expect(out[1]).toBe(tool);
        expect(out[2]).toBe(ai);
    });

    it('leaves message order and count alone — it is not a reorderer', () => {
        const msgs = [new HumanMessage('a'), new AIMessage({ content: [] }), new HumanMessage('b')];
        const out = repairEmptyAiContent(msgs);
        expect(out).toHaveLength(3);
        expect(out[0].content).toBe('a');
        expect(out[2].content).toBe('b');
    });
});
