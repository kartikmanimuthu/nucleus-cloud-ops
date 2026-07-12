import { describe, it, expect } from 'vitest';
import { AIMessage } from '@langchain/core/messages';
import { buildInterruptParts } from '@/app/api/chat/stream-parts';

const ai = (calls: Array<{ id: string; name: string; args?: Record<string, unknown> }>) =>
    new AIMessage({ content: '', tool_calls: calls.map(c => ({ args: {}, ...c, type: 'tool_call' as const })) });

describe('buildInterruptParts', () => {
    it('splits ask_user into data-clarification, rest into one data-approval', () => {
        const values = {
            messages: [ai([
                { id: 't1', name: 'execute_command', args: { command: 'aws ec2 stop-instances' } },
                { id: 't2', name: 'ask_user', args: { question: 'Which region?', options: ['us-east-1'] } },
            ])],
            guardVerdicts: {
                t1: { toolCallId: 't1', toolName: 'execute_command', isMutative: true, severity: 'MEDIUM', action: 'Stops instance', blastRadius: 'Downtime', reversible: true, saferPath: '', reason: 'x' },
                t2: { toolCallId: 't2', toolName: 'ask_user', isMutative: false, severity: 'LOW', action: '', blastRadius: '', reversible: true, saferPath: '', reason: 'x' },
            },
        };
        const parts = buildInterruptParts(values as any, 'thread-1');
        const approval = parts.find(p => p.type === 'data-approval') as any;
        const clarify = parts.find(p => p.type === 'data-clarification') as any;
        expect(approval.data.tools).toHaveLength(1);
        expect(approval.data.tools[0].toolCallId).toBe('t1');
        expect(approval.data.tools[0].guard.severity).toBe('MEDIUM');
        expect(clarify.data.question).toBe('Which region?');
        expect(clarify.data.options).toEqual(['us-east-1']);
    });

    it('orders data-approval BEFORE data-clarification in a mixed batch (deriveRunState resets stale clarifications on data-approval, so approval must lead)', () => {
        const values = {
            messages: [ai([
                { id: 't1', name: 'execute_command', args: { command: 'aws ec2 stop-instances' } },
                { id: 't2', name: 'ask_user', args: { question: 'Which region?', options: ['us-east-1'] } },
            ])],
            guardVerdicts: {
                t1: { toolCallId: 't1', toolName: 'execute_command', isMutative: true, severity: 'MEDIUM', action: 'Stops instance', blastRadius: 'Downtime', reversible: true, saferPath: '', reason: 'x' },
                t2: { toolCallId: 't2', toolName: 'ask_user', isMutative: false, severity: 'LOW', action: '', blastRadius: '', reversible: true, saferPath: '', reason: 'x' },
            },
        };
        const parts = buildInterruptParts(values as any, 'thread-1');
        expect(parts[0].type).toBe('data-approval');
        expect(parts.slice(1).every(p => p.type === 'data-clarification')).toBe(true);
    });

    it('returns [] when nothing is pending', () => {
        expect(buildInterruptParts({ messages: [new AIMessage({ content: 'hi' })], guardVerdicts: {} } as any, 't')).toEqual([]);
    });
});
