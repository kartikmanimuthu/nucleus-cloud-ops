import { describe, it, expect } from 'vitest';
import { reconstructAiContentParts } from '../ai-content-parts';
import { buildTranscript } from '../events';

const noOpts = {
    isStreaming: false,
    toolVisibility: new Map<string, string>(),
    decisions: new Map<string, { approved: boolean; answer?: string }>(),
};

describe('reconstructAiContentParts', () => {
    it('returns null for a plain (non-array) string so the caller keeps the marker path', () => {
        expect(reconstructAiContentParts('PLANNING_PHASE_START\nplan text')).toBeNull();
        expect(reconstructAiContentParts('just an answer')).toBeNull();
    });

    it('returns [] for an array of only empty-text reasoning blocks', () => {
        const raw = JSON.stringify([{ type: 'reasoning', reasoning: '', signature: 'sig' }]);
        expect(reconstructAiContentParts(raw)).toEqual([]);
    });

    it('reconstructs a reasoning block that has text into a single reasoning part', () => {
        const raw = JSON.stringify([{ type: 'reasoning', reasoning: 'Let me think about X.' }]);
        expect(reconstructAiContentParts(raw)).toEqual([{ type: 'reasoning', text: 'Let me think about X.' }]);
    });

    it('reconstructs a mixed [reasoning, text] array preserving order', () => {
        const raw = JSON.stringify([
            { type: 'thinking', thinking: 'thinking hard' },
            { type: 'text', text: 'the answer' },
        ]);
        expect(reconstructAiContentParts(raw)).toEqual([
            { type: 'reasoning', text: 'thinking hard' },
            { type: 'text', text: 'the answer' },
        ]);
    });

    it('extracts the raw Bedrock reasoningContent shape', () => {
        const raw = JSON.stringify([{ reasoningContent: { reasoningText: { text: 'deep thought' } } }]);
        expect(reconstructAiContentParts(raw)).toEqual([{ type: 'reasoning', text: 'deep thought' }]);
    });

    it('drops a reasoningContent block whose text is null', () => {
        const raw = JSON.stringify([{ reasoningContent: { reasoningText: { text: null } } }]);
        expect(reconstructAiContentParts(raw)).toEqual([]);
    });

    it('skips tool_use blocks (tool calls come from metadata)', () => {
        const raw = JSON.stringify([
            { type: 'reasoning', reasoning: '' },
            { type: 'tool_use', id: 't1', name: 'do_it', input: {} },
        ]);
        expect(reconstructAiContentParts(raw)).toEqual([]);
    });

    it('skips empty/whitespace text blocks', () => {
        const raw = JSON.stringify([{ type: 'text', text: '   ' }, { type: 'text', text: 'real' }]);
        expect(reconstructAiContentParts(raw)).toEqual([{ type: 'text', text: 'real' }]);
    });

    it('accepts an already-parsed array (checkpoint-fallback path)', () => {
        expect(reconstructAiContentParts([{ type: 'text', text: 'hi' }])).toEqual([{ type: 'text', text: 'hi' }]);
    });

    // A reasoning model keeps every streamed delta as its own block — 644 of them for
    // one report in the run these tests were written from. One part per block renders
    // as one UI row per block, shattering the answer into hundreds of fragments.
    it('coalesces a run of streamed text deltas into a single part', () => {
        const blocks = ['## Health', ' Report\n\n', 'Cluster is ', 'GREEN.'].map((text) => ({ type: 'text', text }));
        expect(reconstructAiContentParts(JSON.stringify(blocks)))
            .toEqual([{ type: 'text', text: '## Health Report\n\nCluster is GREEN.' }]);
    });

    it('keeps whitespace-only blocks INSIDE a run so words do not fuse', () => {
        // Real shape: Bedrock splits mid-word and emits bare-space deltas between them.
        const blocks = ['No long-running queries, no', ' ', 'bl', 'ocking, no idle-in', '-transaction issues.']
            .map((text) => ({ type: 'text', text }));
        expect(reconstructAiContentParts(JSON.stringify(blocks)))
            .toEqual([{ type: 'text', text: 'No long-running queries, no blocking, no idle-in-transaction issues.' }]);
    });

    it('starts a new part at every type change, preserving order', () => {
        const raw = JSON.stringify([
            { type: 'text', text: 'first ' }, { type: 'text', text: 'answer' },
            { type: 'reasoning', reasoning: 'recon' },
            { type: 'text', text: 'second ' }, { type: 'text', text: 'answer' },
        ]);
        expect(reconstructAiContentParts(raw)).toEqual([
            { type: 'text', text: 'first answer' },
            { type: 'reasoning', text: 'recon' },
            { type: 'text', text: 'second answer' },
        ]);
    });

    it('drops a run that is entirely whitespace', () => {
        const raw = JSON.stringify([{ type: 'text', text: '  ' }, { type: 'text', text: '\n' }]);
        expect(reconstructAiContentParts(raw)).toEqual([]);
    });
});

describe('render parity with live (via buildTranscript)', () => {
    it('a reasoning part with text yields a thinking event, like live', () => {
        const parts = reconstructAiContentParts(JSON.stringify([{ type: 'reasoning', reasoning: 'hmm' }]))!;
        const events = buildTranscript({ id: 'm1', role: 'assistant', parts } as any, noOpts);
        expect(events).toEqual([expect.objectContaining({ kind: 'thinking', text: 'hmm' })]);
    });

    it('the reducer renders nothing for an empty reasoning part (documents live behavior)', () => {
        const events = buildTranscript({ id: 'm1', role: 'assistant', parts: [{ type: 'reasoning', text: '' }] } as any, noOpts);
        expect(events).toEqual([]);
    });
});
