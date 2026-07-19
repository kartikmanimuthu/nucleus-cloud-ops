import { describe, it, expect } from 'vitest';
import { groupEvents } from '../group-events';
import type { TranscriptEvent } from '../events';

type ToolEvent = Extract<TranscriptEvent, { kind: 'tool' }>;

function tool(overrides: Partial<ToolEvent> = {}): ToolEvent {
    return {
        kind: 'tool',
        id: `tool-${Math.random()}`,
        toolCallId: `call-${Math.random()}`,
        toolName: 'execute_command',
        input: { command: 'ls' },
        output: 'ok',
        status: 'done',
        ...overrides,
    };
}

function thinking(id: string): TranscriptEvent {
    return { kind: 'thinking', id, phase: 'execution', text: 'thinking...', streaming: false };
}

function answer(id: string): TranscriptEvent {
    return { kind: 'answer', id, text: 'done', streaming: false };
}

describe('groupEvents', () => {
    it('collapses a run of 3 done tools into one tool-group', () => {
        const events = [tool({ id: 't1' }), tool({ id: 't2' }), tool({ id: 't3' })];
        const result = groupEvents(events);
        expect(result).toHaveLength(1);
        expect(result[0].kind).toBe('tool-group');
        if (result[0].kind === 'tool-group') {
            expect(result[0].tools).toHaveLength(3);
            expect(result[0].tools.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
        }
    });

    it('passes through a run of 2 done tools ungrouped', () => {
        const events = [tool({ id: 't1' }), tool({ id: 't2' })];
        const result = groupEvents(events);
        expect(result).toHaveLength(2);
        expect(result.every((e) => e.kind === 'tool')).toBe(true);
    });

    it('does not group a run containing a running tool (done-running-done)', () => {
        const events = [
            tool({ id: 't1', status: 'done' }),
            tool({ id: 't2', status: 'running' }),
            tool({ id: 't3', status: 'done' }),
        ];
        const result = groupEvents(events);
        expect(result).toHaveLength(3);
        expect(result.every((e) => e.kind === 'tool')).toBe(true);
    });

    it('does not group a run containing an error or rejected tool', () => {
        const errorRun = [tool({ id: 'e1' }), tool({ id: 'e2', status: 'error' }), tool({ id: 'e3' })];
        expect(groupEvents(errorRun)).toHaveLength(3);

        const rejectedRun = [tool({ id: 'r1' }), tool({ id: 'r2', status: 'rejected' }), tool({ id: 'r3' })];
        expect(groupEvents(rejectedRun)).toHaveLength(3);
    });

    it('preserves ordering: thinking, tool, tool, tool, answer', () => {
        const events: TranscriptEvent[] = [
            thinking('th1'),
            tool({ id: 't1' }),
            tool({ id: 't2' }),
            tool({ id: 't3' }),
            answer('a1'),
        ];
        const result = groupEvents(events);
        expect(result.map((e) => e.kind)).toEqual(['thinking', 'tool-group', 'answer']);
    });

    it('groups a longer run of >3 done tools into a single group', () => {
        const events = [
            tool({ id: 't1' }),
            tool({ id: 't2' }),
            tool({ id: 't3' }),
            tool({ id: 't4' }),
            tool({ id: 't5' }),
        ];
        const result = groupEvents(events);
        expect(result).toHaveLength(1);
        if (result[0].kind === 'tool-group') {
            expect(result[0].tools).toHaveLength(5);
        }
    });

    it('handles two separate runs of 3 with a non-tool event between them', () => {
        const events: TranscriptEvent[] = [
            tool({ id: 't1' }),
            tool({ id: 't2' }),
            tool({ id: 't3' }),
            thinking('th1'),
            tool({ id: 't4' }),
            tool({ id: 't5' }),
            tool({ id: 't6' }),
        ];
        const result = groupEvents(events);
        expect(result.map((e) => e.kind)).toEqual(['tool-group', 'thinking', 'tool-group']);
    });

    it('returns an empty array for no events', () => {
        expect(groupEvents([])).toEqual([]);
    });
});
