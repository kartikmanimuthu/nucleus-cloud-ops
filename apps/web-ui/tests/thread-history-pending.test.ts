import { describe, it, expect } from 'vitest';
import { AIMessage } from '@langchain/core/messages';
import { extractThreadRunState } from '@/app/api/threads/[threadId]/run-state';

describe('extractThreadRunState', () => {
    it('returns plan and pending interrupt parts when parked at approval_gate', () => {
        const values = {
            plan: [{ step: 'a', status: 'completed' }, { step: 'b', status: 'in_progress' }],
            messages: [new AIMessage({ content: '', tool_calls: [{ id: 't1', name: 'execute_command', args: { command: 'aws ec2 stop-instances' }, type: 'tool_call' as const }] })],
            guardVerdicts: { t1: { toolCallId: 't1', toolName: 'execute_command', isMutative: true, severity: 'MEDIUM', action: 'stops', blastRadius: 'x', reversible: true, saferPath: '', reason: '' } },
        };
        const rs = extractThreadRunState(values as any, 'th-1');
        expect(rs.plan).toHaveLength(2);
        expect(rs.pendingInterrupt!.parts.some(p => p.type === 'data-approval')).toBe(true);
    });

    it('returns null pendingInterrupt when not parked', () => {
        const rs = extractThreadRunState({ plan: [], messages: [], guardVerdicts: {} } as any, 'th-1');
        expect(rs.pendingInterrupt).toBeNull();
        expect(rs.plan).toBeNull();
    });

    it('returns null pendingInterrupt when the last AI message has no unresolved tool calls (normal completion)', () => {
        const values = {
            plan: [{ step: 'a', status: 'completed' }],
            messages: [new AIMessage({ content: 'Done.' })],
            guardVerdicts: {},
        };
        const rs = extractThreadRunState(values as any, 'th-1');
        expect(rs.pendingInterrupt).toBeNull();
        expect(rs.plan).toHaveLength(1);
    });

    it('returns null pendingInterrupt for non-gate-shaped state (deep-agent style, no guardVerdicts)', () => {
        const values = {
            plan: [],
            messages: [new AIMessage({ content: '', tool_calls: [{ id: 't1', name: 'execute_command', args: {}, type: 'tool_call' as const }] })],
            guardVerdicts: {},
        };
        const rs = extractThreadRunState(values as any, 'th-1');
        expect(rs.pendingInterrupt).toBeNull();
    });
});
