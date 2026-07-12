import { describe, it, expect } from 'vitest';
import { buildDecisionToolMessages } from '@/app/api/chat/decisions';

const pending = [
    { id: 't1', name: 'execute_command', args: { command: 'aws ec2 stop-instances --instance-ids i-1' } },
    { id: 't2', name: 'read_file', args: { file_path: 'x' } },
    { id: 't3', name: 'ask_user', args: { question: 'which region?' } },
];

describe('buildDecisionToolMessages', () => {
    it('rejects partial batches', () => {
        const r = buildDecisionToolMessages(pending, [{ toolCallId: 't1', approved: true }]);
        expect(r.ok).toBe(false);
        expect(!r.ok && r.error).toMatch(/undecided/i);
    });

    it('rejects unknown toolCallIds', () => {
        const r = buildDecisionToolMessages(pending, [
            { toolCallId: 't1', approved: true }, { toolCallId: 't2', approved: true },
            { toolCallId: 't3', approved: true, answer: 'us-east-1' }, { toolCallId: 'ghost', approved: true },
        ]);
        expect(r.ok).toBe(false);
        expect(!r.ok && r.error).toMatch(/unknown/i);
    });

    it('produces ToolMessages only for rejections and ask_user answers', () => {
        const r = buildDecisionToolMessages(pending, [
            { toolCallId: 't1', approved: false, reason: 'too risky' },
            { toolCallId: 't2', approved: true },
            { toolCallId: 't3', approved: true, answer: 'ap-south-1' },
        ]);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.toolMessages).toHaveLength(2);
        const byId = Object.fromEntries(r.toolMessages.map(m => [m.tool_call_id, String(m.content)]));
        expect(byId['t1']).toContain('Rejected by user');
        expect(byId['t1']).toContain('too risky');
        expect(byId['t3']).toBe('ap-south-1');
    });

    it('requires a non-empty answer for approved ask_user', () => {
        const r = buildDecisionToolMessages(pending, [
            { toolCallId: 't1', approved: true }, { toolCallId: 't2', approved: true },
            { toolCallId: 't3', approved: true, answer: '   ' },
        ]);
        expect(r.ok).toBe(false);
        expect(!r.ok && r.error).toMatch(/answer/i);
    });

    it('rejected ask_user gets a dismissal ToolMessage', () => {
        const r = buildDecisionToolMessages(pending, [
            { toolCallId: 't1', approved: true }, { toolCallId: 't2', approved: true },
            { toolCallId: 't3', approved: false },
        ]);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(String(r.toolMessages[0].content)).toContain('declined to answer');
    });
});
