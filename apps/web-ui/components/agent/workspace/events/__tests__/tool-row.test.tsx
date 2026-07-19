// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ToolRow, ToolGroupRow, unwrapToolInput } from '../tool-row';
import type { TranscriptEvent } from '@/lib/agent-chat/events';

type ToolEvent = Extract<TranscriptEvent, { kind: 'tool' }>;

function makeEvent(overrides: Partial<ToolEvent> = {}): ToolEvent {
    return {
        kind: 'tool',
        id: 'e1',
        toolCallId: 'call-1',
        toolName: 'execute_command',
        input: { command: 'aws lambda list-functions' },
        output: 'ok',
        status: 'done',
        ...overrides,
    };
}

describe('unwrapToolInput', () => {
    it('returns primitive/object input unchanged', () => {
        expect(unwrapToolInput({ command: 'ls' })).toEqual({ command: 'ls' });
    });

    it('unwraps { input: string } where the string parses as JSON', () => {
        const wrapped = { input: '{"file_path":"/tmp/x"}' };
        expect(unwrapToolInput(wrapped)).toEqual({ file_path: '/tmp/x' });
    });

    it('leaves { input: string } as-is when the string does not parse as JSON', () => {
        const wrapped = { input: 'not json' };
        expect(unwrapToolInput(wrapped)).toEqual(wrapped);
    });

    it('parses a bare JSON string input', () => {
        expect(unwrapToolInput('{"path":"/a/b"}')).toEqual({ path: '/a/b' });
    });

    it('leaves a bare non-JSON string input as-is', () => {
        expect(unwrapToolInput('plain text')).toBe('plain text');
    });
});

describe('ToolRow', () => {
    it('renders tool name and argument preview from command', () => {
        render(<ToolRow event={makeEvent({ input: { command: 'aws lambda list-functions' } })} />);
        expect(screen.getByText('execute_command')).toBeTruthy();
        expect(screen.getByText('aws lambda list-functions')).toBeTruthy();
    });

    it('expands double-encoded input to show unescaped file_path', () => {
        render(
            <ToolRow
                event={makeEvent({
                    toolName: 'read_file',
                    input: { input: '{"file_path":"/tmp/x"}' },
                })}
            />
        );
        fireEvent.click(screen.getByRole('button'));
        expect(screen.getByText(/"file_path": "\/tmp\/x"/)).toBeTruthy();
    });

    it('renders "Rejected" status chip for rejected tools', () => {
        render(<ToolRow event={makeEvent({ status: 'rejected' })} />);
        expect(screen.getByText('Rejected')).toBeTruthy();
    });

    it('renders a spinner while running', () => {
        render(<ToolRow event={makeEvent({ status: 'running', output: null })} />);
        expect(screen.getByRole('status')).toBeTruthy();
    });

    it('renders a duration when durationMs is provided and status is done', () => {
        render(<ToolRow event={makeEvent({ status: 'done' })} durationMs={1500} />);
        expect(screen.getByText('1.5s')).toBeTruthy();
    });

    it('uses the default Wrench icon for an unknown tool name', () => {
        const { container } = render(<ToolRow event={makeEvent({ toolName: 'some_unmapped_tool' })} />);
        expect(container.querySelector('svg')).toBeTruthy();
    });

    it('pretty-prints an object output when expanded', () => {
        render(<ToolRow event={makeEvent({ output: { ok: true } })} />);
        fireEvent.click(screen.getByRole('button'));
        expect(screen.getByText(/"ok": true/)).toBeTruthy();
    });

    it('renders a string output verbatim when expanded', () => {
        render(<ToolRow event={makeEvent({ output: 'plain output text' })} />);
        fireEvent.click(screen.getByRole('button'));
        expect(screen.getByText('plain output text')).toBeTruthy();
    });
});

describe('ToolGroupRow', () => {
    it('renders "Ran n tools" header and expands to individual rows', () => {
        const tools: ToolEvent[] = [
            makeEvent({ id: 't1', toolCallId: 'c1', toolName: 'execute_command' }),
            makeEvent({ id: 't2', toolCallId: 'c2', toolName: 'read_file' }),
            makeEvent({ id: 't3', toolCallId: 'c3', toolName: 'write_file' }),
        ];
        render(<ToolGroupRow group={{ kind: 'tool-group', id: 'g1', tools }} />);
        expect(screen.getByText('Ran 3 tools')).toBeTruthy();
        expect(screen.queryByText('read_file')).toBeNull();
        fireEvent.click(screen.getByText('Ran 3 tools'));
        expect(screen.getByText('execute_command')).toBeTruthy();
        expect(screen.getByText('read_file')).toBeTruthy();
        expect(screen.getByText('write_file')).toBeTruthy();
    });
});
