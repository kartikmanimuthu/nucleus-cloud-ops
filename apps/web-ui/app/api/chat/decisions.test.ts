import { describe, it, expect } from 'vitest';
import { buildDecisionToolMessages } from './decisions';
import type { PendingToolCall } from '@/lib/agent/guard';

const pending = (overrides: Partial<PendingToolCall> = {}): PendingToolCall => ({
    id: 'call-1',
    name: 'some_tool',
    args: {},
    ...overrides,
} as PendingToolCall);

describe('buildDecisionToolMessages', () => {
    it('returns an error when a decision references an unknown toolCallId', () => {
        const result = buildDecisionToolMessages(
            [pending({ id: 'call-1' })],
            [{ toolCallId: 'call-1', approved: true }, { toolCallId: 'call-ghost', approved: true }]
        );
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/Unknown toolCallId\(s\): call-ghost/);
    });

    it('returns an error when a pending call has no matching decision', () => {
        const result = buildDecisionToolMessages(
            [pending({ id: 'call-1', name: 'write_file' })],
            []
        );
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/Undecided tool call\(s\): write_file \(call-1\)/);
    });

    it('produces no ToolMessage for an approved normal tool call', () => {
        const result = buildDecisionToolMessages(
            [pending({ id: 'call-1', name: 'write_file' })],
            [{ toolCallId: 'call-1', approved: true }]
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.toolMessages).toHaveLength(0);
            expect(result.approvedIds).toEqual(['call-1']);
            expect(result.rejectedIds).toEqual([]);
        }
    });

    it('produces a rejection ToolMessage with reason for a rejected normal tool call', () => {
        const result = buildDecisionToolMessages(
            [pending({ id: 'call-1', name: 'write_file' })],
            [{ toolCallId: 'call-1', approved: false, reason: 'too risky' }]
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.toolMessages).toHaveLength(1);
            expect(result.toolMessages[0].content).toMatch(/Rejected by user — reason: too risky/);
            expect(result.rejectedIds).toEqual(['call-1']);
        }
    });

    it('produces a rejection ToolMessage without a reason clause when reason is omitted', () => {
        const result = buildDecisionToolMessages(
            [pending({ id: 'call-1', name: 'write_file' })],
            [{ toolCallId: 'call-1', approved: false }]
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.toolMessages[0].content).toBe(
                'Rejected by user. Do not retry this exact action; adapt or ask.'
            );
        }
    });

    it('requires a non-empty answer for an approved ask_user call', () => {
        const result = buildDecisionToolMessages(
            [pending({ id: 'call-1', name: 'ask_user' })],
            [{ toolCallId: 'call-1', approved: true, answer: '   ' }]
        );
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/requires a non-empty answer/);
    });

    it('produces a ToolMessage with the trimmed answer for an approved ask_user call', () => {
        const result = buildDecisionToolMessages(
            [pending({ id: 'call-1', name: 'ask_user' })],
            [{ toolCallId: 'call-1', approved: true, answer: '  42  ' }]
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.toolMessages[0].content).toBe('42');
            expect(result.approvedIds).toEqual(['call-1']);
        }
    });

    it('produces a decline ToolMessage for a rejected ask_user call', () => {
        const result = buildDecisionToolMessages(
            [pending({ id: 'call-1', name: 'ask_user' })],
            [{ toolCallId: 'call-1', approved: false }]
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.toolMessages[0].content).toMatch(/user declined to answer/);
            expect(result.rejectedIds).toEqual(['call-1']);
        }
    });
});
