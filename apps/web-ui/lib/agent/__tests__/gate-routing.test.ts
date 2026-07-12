import { describe, it, expect } from 'vitest';
import { AIMessage } from '@langchain/core/messages';
import { routeAfterGuard } from '@/lib/agent/gate-routing';

const stateWith = (calls: Array<{ id: string; name: string }>, verdicts: Record<string, { isMutative: boolean }>) => ({
    messages: [new AIMessage({ content: '', tool_calls: calls.map(c => ({ ...c, args: {}, type: 'tool_call' as const })) })],
    guardVerdicts: Object.fromEntries(Object.entries(verdicts).map(([id, v]) => [id, { toolCallId: id, toolName: 'x', severity: 'HIGH', action: '', blastRadius: '', reversible: false, saferPath: '', reason: '', ...v }])),
} as any);

describe('routeAfterGuard', () => {
    it('all read-only + autoApprove on → tools', () => {
        const s = stateWith([{ id: 't1', name: 'read_file' }], { t1: { isMutative: false } });
        expect(routeAfterGuard(s, true)).toBe('tools');
    });

    it('any mutative → approval_gate even with autoApprove on', () => {
        const s = stateWith([{ id: 't1', name: 'read_file' }, { id: 't2', name: 'execute_command' }],
            { t1: { isMutative: false }, t2: { isMutative: true } });
        expect(routeAfterGuard(s, true)).toBe('approval_gate');
    });

    it('autoApprove off → approval_gate even for read-only', () => {
        const s = stateWith([{ id: 't1', name: 'read_file' }], { t1: { isMutative: false } });
        expect(routeAfterGuard(s, false)).toBe('approval_gate');
    });

    it('ask_user always → approval_gate', () => {
        const s = stateWith([{ id: 't1', name: 'ask_user' }], { t1: { isMutative: false } });
        expect(routeAfterGuard(s, true)).toBe('approval_gate');
    });

    it('missing verdict for a pending call → approval_gate (fail-closed)', () => {
        const s = stateWith([{ id: 't1', name: 'mystery_tool' }], {});
        expect(routeAfterGuard(s, true)).toBe('approval_gate');
    });
});
