import { describe, it, expect } from 'vitest';
import { buildTranscript } from '../events';

const msg = (parts: any[], id = 'm1') => ({ id, role: 'assistant', parts });
const noOpts = {
    isStreaming: false,
    toolVisibility: new Map<string, string>(),
    decisions: new Map<string, { approved: boolean; answer?: string }>(),
};

describe('phase tracking', () => {
    it('tags reasoning with the phase from the preceding data-phase part', () => {
        const events = buildTranscript(msg([
            { type: 'data-phase', data: { phase: 'planning' } },
            { type: 'reasoning', text: 'Let me plan.' },
        ]), noOpts);
        expect(events).toEqual([
            expect.objectContaining({ kind: 'thinking', phase: 'planning', text: 'Let me plan.' }),
        ]);
    });

    it('data-phase parts themselves emit no event', () => {
        const events = buildTranscript(msg([
            { type: 'data-phase', data: { phase: 'execution' } },
        ]), noOpts);
        expect(events).toEqual([]);
    });

    it('defaults to phase "text" before any data-phase part is seen', () => {
        const events = buildTranscript(msg([
            { type: 'reasoning', text: 'no phase yet' },
        ]), noOpts);
        expect((events[0] as any).phase).toBe('text');
    });

    it('updates phase again on a later data-phase part', () => {
        const events = buildTranscript(msg([
            { type: 'data-phase', data: { phase: 'planning' } },
            { type: 'reasoning', text: 'plan step' },
            { type: 'data-phase', data: { phase: 'execution' } },
            { type: 'text', text: 'executing now' },
        ]), noOpts);
        expect(events.map((e: any) => e.phase ?? null)).toEqual(['planning', null]);
    });
});

describe('sentinel stripping', () => {
    it('strips a leading PLANNING_PHASE_START marker', () => {
        const events = buildTranscript(msg([
            { type: 'reasoning', text: 'PLANNING_PHASE_START\nLet me plan.' },
        ]), noOpts);
        expect((events[0] as any).text).toBe('Let me plan.');
    });

    it('strips each of the other sentinel markers', () => {
        const markers = [
            'EXECUTION_PHASE_START', 'REFLECTION_PHASE_START', 'REVISION_PHASE_START',
            'FINAL_PHASE_START', 'MEMORY_RECALL_PHASE_START', 'MEMORY_SAVE_PHASE_START',
        ];
        for (const marker of markers) {
            const events = buildTranscript(msg([
                { type: 'reasoning', text: `${marker}\nBody text` },
            ]), noOpts);
            const rendered = events.map((e: any) => e.text ?? e.summary).join('');
            expect(rendered).toBe('Body text');
        }
    });

    it('reasoning text that is empty after stripping the sentinel emits nothing', () => {
        const events = buildTranscript(msg([
            { type: 'reasoning', text: 'PLANNING_PHASE_START\n' },
        ]), noOpts);
        expect(events).toEqual([]);
    });
});

describe('reasoning merging', () => {
    it('merges consecutive reasoning parts with the same phase into one thinking event', () => {
        const events = buildTranscript(msg([
            { type: 'data-phase', data: { phase: 'planning' } },
            { type: 'reasoning', text: 'Step one. ' },
            { type: 'reasoning', text: 'Step two.' },
        ]), noOpts);
        expect(events).toHaveLength(1);
        expect((events[0] as any).text).toBe('Step one. Step two.');
    });

    it('does NOT merge reasoning parts separated by a tool event', () => {
        const events = buildTranscript(msg([
            { type: 'data-phase', data: { phase: 'execution' } },
            { type: 'reasoning', text: 'Before tool.' },
            { type: 'tool-execute_command', toolCallId: 'tc1', state: 'output-available', input: {}, output: 'ok' },
            { type: 'reasoning', text: 'After tool.' },
        ]), { ...noOpts, toolVisibility: new Map([['tc1', 'm1']]) });
        const thinkingEvents = events.filter((e: any) => e.kind === 'thinking');
        expect(thinkingEvents).toHaveLength(2);
        expect(thinkingEvents.map((e: any) => e.text)).toEqual(['Before tool.', 'After tool.']);
    });

    it('does not merge reasoning parts across different phases', () => {
        const events = buildTranscript(msg([
            { type: 'data-phase', data: { phase: 'planning' } },
            { type: 'reasoning', text: 'Planning bit.' },
            { type: 'data-phase', data: { phase: 'execution' } },
            { type: 'reasoning', text: 'Executing bit.' },
        ]), noOpts);
        const thinkingEvents = events.filter((e: any) => e.kind === 'thinking');
        expect(thinkingEvents).toHaveLength(2);
    });

    it('structural parts (step-start, data-plan) do not break a reasoning merge', () => {
        const events = buildTranscript(msg([
            { type: 'data-phase', data: { phase: 'execution' } },
            { type: 'reasoning', text: 'Part one.' },
            { type: 'step-start' },
            { type: 'data-plan', data: { steps: [], updatedBy: null } },
            { type: 'reasoning', text: ' Part two.' },
        ]), noOpts);
        const thinkingEvents = events.filter((e: any) => e.kind === 'thinking');
        expect(thinkingEvents).toHaveLength(1);
        expect((thinkingEvents[0] as any).text).toBe('Part one. Part two.');
    });

    it('a whitespace-only text part (emits no event) does not break a reasoning merge', () => {
        const events = buildTranscript(msg([
            { type: 'data-phase', data: { phase: 'execution' } },
            { type: 'reasoning', text: 'Step one.' },
            { type: 'text', text: ' ' },
            { type: 'reasoning', text: 'Step two.' },
        ]), noOpts);
        const thinkingEvents = events.filter((e: any) => e.kind === 'thinking');
        expect(thinkingEvents).toHaveLength(1);
        expect((thinkingEvents[0] as any).text).toBe('Step one.Step two.');
    });
});

describe('tool events', () => {
    it('emits a running tool event while input-only (no output yet)', () => {
        const events = buildTranscript(msg([
            { type: 'tool-execute_command', toolCallId: 'tc1', state: 'input-available', input: { command: 'ls' } },
        ]), { ...noOpts, toolVisibility: new Map([['tc1', 'm1']]) });
        expect(events).toEqual([
            expect.objectContaining({ kind: 'tool', toolCallId: 'tc1', toolName: 'execute_command', status: 'running' }),
        ]);
    });

    it('emits a done tool event when output is present', () => {
        const events = buildTranscript(msg([
            { type: 'tool-execute_command', toolCallId: 'tc1', state: 'output-available', input: {}, output: 'ls output' },
        ]), { ...noOpts, toolVisibility: new Map([['tc1', 'm1']]) });
        expect(events[0]).toEqual(expect.objectContaining({ kind: 'tool', status: 'done', output: 'ls output' }));
    });

    it('emits an error tool event when state is output-error', () => {
        const events = buildTranscript(msg([
            { type: 'tool-execute_command', toolCallId: 'tc1', state: 'output-error', input: {}, output: 'boom' },
        ]), { ...noOpts, toolVisibility: new Map([['tc1', 'm1']]) });
        expect(events[0]).toEqual(expect.objectContaining({ kind: 'tool', status: 'error' }));
    });

    it('emits a rejected tool event when isRejectedToolResult matches the synthetic server output', () => {
        const events = buildTranscript(msg([
            {
                type: 'tool-execute_command', toolCallId: 'tc1', state: 'output-available', input: {},
                output: 'Rejected by user. Do not retry this exact action; adapt or ask.',
            },
        ]), { ...noOpts, toolVisibility: new Map([['tc1', 'm1']]) });
        expect(events[0]).toEqual(expect.objectContaining({ kind: 'tool', status: 'rejected' }));
    });

    it('emits a rejected tool event from a local batch-card decision, even before output exists', () => {
        const events = buildTranscript(msg([
            { type: 'tool-execute_command', toolCallId: 'tc1', state: 'input-available', input: {} },
        ]), {
            ...noOpts,
            toolVisibility: new Map([['tc1', 'm1']]),
            decisions: new Map([['tc1', { approved: false }]]),
        });
        expect(events[0]).toEqual(expect.objectContaining({ kind: 'tool', status: 'rejected' }));
    });

    it('derives toolName from part.toolName when present (dynamic-tool parts)', () => {
        const events = buildTranscript(msg([
            { type: 'dynamic-tool', toolCallId: 'tc1', toolName: 'search_kb', state: 'input-available', input: {} },
        ]), { ...noOpts, toolVisibility: new Map([['tc1', 'm1']]) });
        expect((events[0] as any).toolName).toBe('search_kb');
    });

    it('falls back to stripping the tool- prefix from part.type when toolName is absent', () => {
        const events = buildTranscript(msg([
            { type: 'tool-write_file', toolCallId: 'tc1', state: 'input-available', input: {} },
        ]), { ...noOpts, toolVisibility: new Map([['tc1', 'm1']]) });
        expect((events[0] as any).toolName).toBe('write_file');
    });

    it('falls back to part.args when input is absent (history-reload tool-invocation parts)', () => {
        const events = buildTranscript(msg([
            {
                type: 'tool-invocation', toolCallId: 'tc1', toolName: 'execute_command',
                args: { command: 'aws s3 ls' }, result: 'output', state: 'output-available',
            },
        ]), { ...noOpts, toolVisibility: new Map([['tc1', 'm1']]) });
        expect(events[0]).toEqual(expect.objectContaining({ input: { command: 'aws s3 ls' } }));
    });
});

describe('tool dedupe', () => {
    it('skips a tool part whose visibility winner is another message', () => {
        const vis = new Map([['tc1', 'OTHER']]);
        const events = buildTranscript(msg([
            { type: 'tool-execute_command', toolCallId: 'tc1', state: 'input-available', input: {} },
        ]), { ...noOpts, toolVisibility: vis });
        expect(events).toEqual([]);
    });

    it('keeps a tool part whose visibility winner IS this message', () => {
        const vis = new Map([['tc1', 'm1']]);
        const events = buildTranscript(msg([
            { type: 'tool-execute_command', toolCallId: 'tc1', state: 'input-available', input: {} },
        ]), { ...noOpts, toolVisibility: vis });
        expect(events).toHaveLength(1);
    });
});

describe('data-memory parts', () => {
    it('emits a memory event from a data-memory part', () => {
        const events = buildTranscript(msg([
            { type: 'data-memory', data: { op: 'recall', summary: 'Found 3 related memories', count: 3 } },
        ]), noOpts);
        expect(events).toEqual([
            expect.objectContaining({ kind: 'memory', op: 'recall', summary: 'Found 3 related memories', count: 3 }),
        ]);
    });

    it('supports op: save with a null count', () => {
        const events = buildTranscript(msg([
            { type: 'data-memory', data: { op: 'save', summary: 'Saved a new learning', count: null } },
        ]), noOpts);
        expect(events[0]).toEqual(expect.objectContaining({ kind: 'memory', op: 'save', count: null }));
    });
});

describe('answer events', () => {
    it('emits an answer event for a text part', () => {
        const events = buildTranscript(msg([
            { type: 'text', text: 'Here is the result.' },
        ]), noOpts);
        expect(events).toEqual([
            expect.objectContaining({ kind: 'answer', text: 'Here is the result.' }),
        ]);
    });

    it('emits nothing for a whitespace-only text part (backend placeholder)', () => {
        const events = buildTranscript(msg([
            { type: 'text', text: ' ' },
        ]), noOpts);
        expect(events).toEqual([]);
    });
});

describe('legacy memory-phase reasoning', () => {
    it('turns memory_recall-phase reasoning into a memory event, not a thinking event', () => {
        const events = buildTranscript(msg([
            { type: 'data-phase', data: { phase: 'memory_recall' } },
            { type: 'reasoning', text: 'MEMORY_RECALL_PHASE_START\nFound relevant memories.' },
        ]), noOpts);
        expect(events).toEqual([
            expect.objectContaining({ kind: 'memory', op: 'recall', summary: 'Found relevant memories.', count: null }),
        ]);
    });

    it('turns memory_save-phase reasoning into a memory event with op save', () => {
        const events = buildTranscript(msg([
            { type: 'data-phase', data: { phase: 'memory_save' } },
            { type: 'reasoning', text: 'MEMORY_SAVE_PHASE_START\nSaved a learning.' },
        ]), noOpts);
        expect(events[0]).toEqual(expect.objectContaining({ kind: 'memory', op: 'save', summary: 'Saved a learning.' }));
    });
});

describe('streaming flag', () => {
    it('marks the last event streaming when isStreaming is true', () => {
        const events = buildTranscript(msg([
            { type: 'data-phase', data: { phase: 'planning' } },
            { type: 'reasoning', text: 'Thinking...' },
        ]), { ...noOpts, isStreaming: true });
        expect(events[events.length - 1]).toEqual(expect.objectContaining({ streaming: true }));
    });

    it('does not mark a non-last event streaming', () => {
        const events = buildTranscript(msg([
            { type: 'reasoning', text: 'First thought.' },
            { type: 'tool-execute_command', toolCallId: 'tc1', state: 'output-available', input: {}, output: 'ok' },
            { type: 'text', text: 'Final answer.' },
        ]), { ...noOpts, isStreaming: true, toolVisibility: new Map([['tc1', 'm1']]) });
        const thinking = events.find((e: any) => e.kind === 'thinking');
        const answer = events.find((e: any) => e.kind === 'answer');
        expect((thinking as any).streaming).toBe(false);
        expect(answer).toEqual(expect.objectContaining({ streaming: true }));
    });

    it('does not mark anything streaming when isStreaming is false', () => {
        const events = buildTranscript(msg([
            { type: 'text', text: 'done' },
        ]), { ...noOpts, isStreaming: false });
        expect((events[0] as any).streaming).toBe(false);
    });
});

describe('rail/card-only parts', () => {
    it('emits nothing for data-plan, data-approval, data-clarification, and step-start parts', () => {
        const events = buildTranscript(msg([
            { type: 'data-plan', data: { steps: [], updatedBy: null } },
            { type: 'data-approval', data: { batchId: 'b1', tools: [] } },
            { type: 'data-clarification', data: { toolCallId: 't1', question: 'q', options: [] } },
            { type: 'step-start' },
        ]), noOpts);
        expect(events).toEqual([]);
    });
});
