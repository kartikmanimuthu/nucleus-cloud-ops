import { describe, it, expect } from 'vitest';
import { fanOutDecision, resolveDeepPendingActions } from './deep-batch-decision';
import type { AgentOpsRun } from './types';

const actions = [
    { toolCallId: 'a', toolName: 'execute_command', args: {}, interruptId: 'i1', index: 0 },
    { toolCallId: 'b', toolName: 'write_file', args: {}, interruptId: 'i1', index: 1 },
    { toolCallId: 'c', toolName: 'execute_command', args: {}, interruptId: 'i2', index: 0 },
];

describe('fanOutDecision', () => {
    it('approves every action, grouped by interrupt id', () => {
        const map = fanOutDecision(actions, 'approve');
        expect(map.i1.decisions).toEqual([{ type: 'approve' }, { type: 'approve' }]);
        expect(map.i2.decisions).toEqual([{ type: 'approve' }]);
    });

    it('rejects every action with an explanatory message', () => {
        const map = fanOutDecision(actions, 'reject');
        expect(map.i1.decisions[0].type).toBe('reject');
        expect((map.i1.decisions[0] as { message: string }).message).toMatch(/rejected/i);
    });

    it('answers ask_user with respond, never approve — approve would hang the tool', () => {
        const map = fanOutDecision(
            [{ toolCallId: 'q', toolName: 'ask_user', args: {}, interruptId: 'i9', index: 0 }],
            'approve',
        );
        expect(map.i9.decisions[0].type).toBe('respond');
    });

    it('places decisions at their positional index, not append order', () => {
        const map = fanOutDecision(
            [{ toolCallId: 'z', toolName: 'execute_command', args: {}, interruptId: 'i1', index: 2 }],
            'approve',
        );
        expect(map.i1.decisions[2]).toEqual({ type: 'approve' });
    });

    it('returns an empty map for no actions', () => {
        expect(fanOutDecision([], 'approve')).toEqual({});
    });
});

describe('resolveDeepPendingActions', () => {
    it('returns the pending actions on the happy path', () => {
        const run = { approvalRequest: { planSteps: [], approvalType: 'deep_actions', pendingActions: actions } } as unknown as AgentOpsRun;
        const result = resolveDeepPendingActions(run);
        expect(result).toEqual({ ok: true, actions });
    });

    it('fails with the canonical error when approvalRequest is missing', () => {
        const run = {} as unknown as AgentOpsRun;
        const result = resolveDeepPendingActions(run);
        expect(result).toEqual({ ok: false, error: 'Deep run has no pending actions recorded.' });
    });

    it('fails with the canonical error when pendingActions is an empty array', () => {
        const run = { approvalRequest: { planSteps: [], approvalType: 'deep_actions', pendingActions: [] } } as unknown as AgentOpsRun;
        const result = resolveDeepPendingActions(run);
        expect(result).toEqual({ ok: false, error: 'Deep run has no pending actions recorded.' });
    });
});
