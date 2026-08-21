import { describe, it, expect } from 'vitest';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { findRenderedDeliverable, tagMessagePhase } from '@/lib/agent/agent-shared';

const long = (marker: string) => `${marker} ${'x'.repeat(900)}`;

/**
 * Sonnet 5 returns a reasoning turn as a block array and splits the answer into
 * one text block per streamed delta — 544 blocks for a single 7k-char report in
 * the run this test was written from.
 */
function sonnet5Blocks(text: string) {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += 12) chunks.push(text.slice(i, i + 12));
    return [
        { type: 'reasoning_content', reasoningText: { signature: 'Eo8F', text: 'deliberating' } },
        ...chunks.map((t) => ({ type: 'text', text: t })),
    ];
}

describe('findRenderedDeliverable', () => {
    it('promotes a plain-string execution message', () => {
        const msgs = [tagMessagePhase(new AIMessage({ content: long('REPORT') }), 'execution')];
        expect(findRenderedDeliverable(msgs)).toBe(long('REPORT'));
    });

    it('promotes a reasoning-model block array (Sonnet 5 fragmented content)', () => {
        const report = long('REPORT');
        const blocks = sonnet5Blocks(report);
        expect(blocks.length).toBeGreaterThan(50); // genuinely fragmented, not a 2-block array
        const msgs = [tagMessagePhase(new AIMessage({ content: blocks as never }), 'execution')];
        expect(findRenderedDeliverable(msgs)).toBe(report);
    });

    it('ignores a reasoning-only turn that carries no answer text', () => {
        const msgs = [tagMessagePhase(
            new AIMessage({ content: [{ type: 'reasoning_content', reasoningText: { signature: 'Eo8F', text: 'x'.repeat(5000) } }] as never }),
            'execution',
        )];
        expect(findRenderedDeliverable(msgs)).toBeNull();
    });

    it('ignores short narration and non-deliverable phases', () => {
        expect(findRenderedDeliverable([
            tagMessagePhase(new AIMessage({ content: 'Now pulling CloudWatch metrics.' }), 'execution'),
            tagMessagePhase(new AIMessage({ content: long('REFLECTION') }), 'reflection'),
            tagMessagePhase(new AIMessage({ content: long('PLAN') }), 'planning'),
            new HumanMessage({ content: long('USER') }),
        ])).toBeNull();
    });

    it('returns the latest deliverable when a revision follows the execution', () => {
        const msgs = [
            tagMessagePhase(new AIMessage({ content: long('FIRST') }), 'execution'),
            tagMessagePhase(new AIMessage({ content: sonnet5Blocks(long('REVISED')) as never }), 'revision'),
        ];
        expect(findRenderedDeliverable(msgs)).toBe(long('REVISED'));
    });
});
