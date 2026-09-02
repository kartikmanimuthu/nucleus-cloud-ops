import { describe, it, expect } from 'vitest';
import {
    actionId, hasPendingInterrupt, pendingActions, toResumeMap, syntheticOutput, parseActionIdForTest,
    type PendingAction,
} from './hitl';
import type { ToolDecision } from '@/app/api/chat/decisions';

describe('actionId / parseActionId', () => {
    it('joins interruptId and index with # when no checkpointId is given', () => {
        expect(actionId('int-1', 0)).toBe('int-1#0');
    });
    it('prefixes with checkpointId when given', () => {
        expect(actionId('int-1', 2, 'ckpt-9')).toBe('ckpt-9:int-1#2');
    });
    it('round-trips a plain id (no checkpoint prefix)', () => {
        expect(parseActionIdForTest('int-1#3')).toEqual({ interruptId: 'int-1', index: 3 });
    });
    it('round-trips a checkpoint-prefixed id, stripping only the LAST colon segment', () => {
        expect(parseActionIdForTest('ckpt-9:int-1#3')).toEqual({ interruptId: 'int-1', index: 3 });
    });
    it('returns null when there is no # separator', () => {
        expect(parseActionIdForTest('no-hash-here')).toBeNull();
    });
    it('returns null when # is the first character', () => {
        expect(parseActionIdForTest('#0')).toBeNull();
    });
    it('returns null when the index is not a non-negative integer', () => {
        expect(parseActionIdForTest('int-1#abc')).toBeNull();
        expect(parseActionIdForTest('int-1#-1')).toBeNull();
        expect(parseActionIdForTest('int-1#1.5')).toBeNull();
    });
});

describe('hasPendingInterrupt', () => {
    it('is false with no tasks', () => {
        expect(hasPendingInterrupt({})).toBe(false);
    });
    it('is false when tasks have no interrupts', () => {
        expect(hasPendingInterrupt({ tasks: [{}, { interrupts: [] }] })).toBe(false);
    });
    it('is true when any task has a non-empty interrupts array', () => {
        expect(hasPendingInterrupt({ tasks: [{}, { interrupts: [{ id: 'i1' }] }] })).toBe(true);
    });
});

describe('pendingActions', () => {
    it('returns [] when there are no tasks', () => {
        expect(pendingActions({})).toEqual([]);
    });

    it('flattens actionRequests across multiple interrupts and tasks, prefixed with the checkpoint id', () => {
        const state = {
            config: { configurable: { checkpoint_id: 'ckpt-1' } },
            tasks: [
                { interrupts: [{ id: 'int-a', value: { actionRequests: [{ name: 'stop_instance', args: { id: 'i-1' } }] } }] },
                { interrupts: [{ id: 'int-b', value: { actionRequests: [{ name: 'ask_user' }, { name: 'delete_bucket', args: {} }] } }] },
            ],
        };

        const result = pendingActions(state);

        expect(result).toEqual([
            { toolCallId: 'ckpt-1:int-a#0', toolName: 'stop_instance', args: { id: 'i-1' }, interruptId: 'int-a', index: 0 },
            { toolCallId: 'ckpt-1:int-b#0', toolName: 'ask_user', args: {}, interruptId: 'int-b', index: 0 },
            { toolCallId: 'ckpt-1:int-b#1', toolName: 'delete_bucket', args: {}, interruptId: 'int-b', index: 1 },
        ]);
    });

    it('skips an interrupt with no id', () => {
        const state = { tasks: [{ interrupts: [{ value: { actionRequests: [{ name: 'x' }] } }] }] };
        expect(pendingActions(state)).toEqual([]);
    });

    it('defaults args to {} and name to empty string when absent', () => {
        const state = { tasks: [{ interrupts: [{ id: 'int-a', value: { actionRequests: [{}] } }] }] };
        expect(pendingActions(state)).toEqual([
            { toolCallId: 'int-a#0', toolName: '', args: {}, interruptId: 'int-a', index: 0 },
        ]);
    });

    it('omits the checkpoint prefix when checkpoint_id is not a string', () => {
        const state = { config: { configurable: { checkpoint_id: 42 } }, tasks: [{ interrupts: [{ id: 'int-a', value: { actionRequests: [{ name: 'x' }] } }] }] };
        expect(pendingActions(state)[0].toolCallId).toBe('int-a#0');
    });
});

function pending(overrides: Partial<PendingAction> = {}): PendingAction {
    return { toolCallId: 'int-a#0', toolName: 'stop_instance', args: {}, interruptId: 'int-a', index: 0, ...overrides };
}

describe('toResumeMap', () => {
    it('rejects unknown toolCallIds not present in pending', () => {
        const result = toResumeMap([], [{ toolCallId: 'ghost#0', approved: true }]);
        expect(result).toEqual({ ok: false, error: 'Unknown toolCallId(s): ghost#0' });
    });

    it('rejects when a pending action has no decision', () => {
        const result = toResumeMap([pending()], []);
        expect(result.ok).toBe(false);
        expect((result as { error: string }).error).toContain('Undecided tool call(s): stop_instance (int-a#0)');
    });

    it('approves a normal mutative tool call', () => {
        const result = toResumeMap([pending()], [{ toolCallId: 'int-a#0', approved: true }]);
        expect(result).toEqual({ ok: true, resume: { 'int-a': { decisions: [{ type: 'approve' }] } } });
    });

    it('rejects a normal tool call with a reason', () => {
        const result = toResumeMap([pending()], [{ toolCallId: 'int-a#0', approved: false, reason: 'too risky' }]);
        expect(result).toEqual({
            ok: true,
            resume: { 'int-a': { decisions: [{ type: 'reject', message: 'Rejected by user — reason: too risky. Do not retry this exact action; adapt or ask.' }] } },
        });
    });

    it('rejects a normal tool call with no reason, omitting the reason clause', () => {
        const result = toResumeMap([pending()], [{ toolCallId: 'int-a#0', approved: false }]);
        expect((result as { resume: any }).resume['int-a'].decisions[0].message).toBe('Rejected by user. Do not retry this exact action; adapt or ask.');
    });

    it('converts an approved ask_user with an answer into a respond decision', () => {
        const askUser = pending({ toolName: 'ask_user' });
        const result = toResumeMap([askUser], [{ toolCallId: 'int-a#0', approved: true, answer: '  us-east-1  ' }]);
        expect(result).toEqual({ ok: true, resume: { 'int-a': { decisions: [{ type: 'respond', message: 'us-east-1' }] } } });
    });

    it('rejects when an approved ask_user has no non-empty answer', () => {
        const askUser = pending({ toolName: 'ask_user' });
        const result = toResumeMap([askUser], [{ toolCallId: 'int-a#0', approved: true, answer: '   ' }]);
        expect(result).toEqual({ ok: false, error: 'ask_user (int-a#0) requires a non-empty answer.' });
    });

    it('converts a declined ask_user into a respond decision with the standard decline message', () => {
        const askUser = pending({ toolName: 'ask_user' });
        const result = toResumeMap([askUser], [{ toolCallId: 'int-a#0', approved: false }]);
        expect((result as { resume: any }).resume['int-a'].decisions[0]).toEqual({
            type: 'respond', message: 'The user declined to answer. Proceed with your best judgment or finish and state the open question.',
        });
    });

    it('groups multiple decisions under the same interruptId by index', () => {
        const p1 = pending({ toolCallId: 'int-a#0', index: 0 });
        const p2 = pending({ toolCallId: 'int-a#1', index: 1, toolName: 'delete_bucket' });
        const decisions: ToolDecision[] = [
            { toolCallId: 'int-a#0', approved: true },
            { toolCallId: 'int-a#1', approved: false, reason: 'no' },
        ];
        const result = toResumeMap([p1, p2], decisions);
        expect((result as { resume: any }).resume['int-a'].decisions).toHaveLength(2);
        expect((result as { resume: any }).resume['int-a'].decisions[0]).toEqual({ type: 'approve' });
    });
});

describe('syntheticOutput', () => {
    it('returns the trimmed answer for an approved ask_user', () => {
        expect(syntheticOutput(pending({ toolName: 'ask_user' }), { toolCallId: 'x', approved: true, answer: '  yes  ' })).toBe('yes');
    });
    it('falls back to the decline message when an approved ask_user has a blank answer', () => {
        expect(syntheticOutput(pending({ toolName: 'ask_user' }), { toolCallId: 'x', approved: true, answer: '   ' })).toBe('The user declined to answer.');
    });
    it('returns the decline message for a declined ask_user', () => {
        expect(syntheticOutput(pending({ toolName: 'ask_user' }), { toolCallId: 'x', approved: false })).toBe('The user declined to answer.');
    });
    it('returns a rejection message with a reason for a normal tool', () => {
        expect(syntheticOutput(pending(), { toolCallId: 'x', approved: false, reason: 'too risky' })).toBe('Rejected by user — reason: too risky.');
    });
    it('returns a bare rejection message with no reason', () => {
        expect(syntheticOutput(pending(), { toolCallId: 'x', approved: false })).toBe('Rejected by user.');
    });
});
