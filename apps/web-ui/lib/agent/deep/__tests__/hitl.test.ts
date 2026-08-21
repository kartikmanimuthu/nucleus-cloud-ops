import { describe, it, expect } from 'vitest';
import { pendingActions, toResumeMap, hasPendingInterrupt, actionId } from '@/lib/agent/deep/hitl';

/** Shape of a real paused deep run, taken from a live thread's getState(). */
function stateWith(interrupts: Array<{ id: string; names: string[] }>) {
    return {
        tasks: interrupts.map(i => ({
            interrupts: [{
                id: i.id,
                value: {
                    actionRequests: i.names.map((name, n) => ({ name, args: { command: `cmd-${i.id}-${n}` } })),
                    reviewConfigs: [],
                },
            }],
        })),
    };
}

describe('hasPendingInterrupt', () => {
    it('is true when any task holds an interrupt', () => {
        expect(hasPendingInterrupt(stateWith([{ id: 'a', names: ['execute_command'] }]))).toBe(true);
    });

    it('is false once interrupts are consumed', () => {
        expect(hasPendingInterrupt({ tasks: [{ interrupts: [] }] })).toBe(false);
        expect(hasPendingInterrupt({})).toBe(false);
    });
});

describe('pendingActions', () => {
    // The parent's last AI message shows `task`, not the gated call, so message-derived
    // detection returned nothing and the run hung with no way to approve.
    it('surfaces subagent interrupts, which never appear in the parent message', () => {
        const state = stateWith([
            { id: 'i1', names: ['execute_command', 'execute_command'] },
            { id: 'i2', names: ['execute_command', 'execute_command'] },
            { id: 'i3', names: ['execute_command', 'execute_command', 'execute_command', 'execute_command'] },
        ]);
        const pending = pendingActions(state);
        expect(pending).toHaveLength(8);
        expect(pending[0].toolCallId).toBe('i1#0');
        expect(pending[7].toolCallId).toBe('i3#3');
        expect(pending[7].interruptId).toBe('i3');
        expect(pending[7].index).toBe(3);
    });

    it('carries the action args through for the approval card', () => {
        const [first] = pendingActions(stateWith([{ id: 'i1', names: ['execute_command'] }]));
        expect(first.args).toEqual({ command: 'cmd-i1-0' });
    });

    it('returns nothing when no interrupt is pending', () => {
        expect(pendingActions({ tasks: [{ interrupts: [] }] })).toEqual([]);
        expect(pendingActions({})).toEqual([]);
    });

    it('skips interrupts with no id, which cannot be resumed', () => {
        expect(pendingActions({ tasks: [{ interrupts: [{ value: { actionRequests: [{ name: 'x' }] } }] }] })).toEqual([]);
    });
});

describe('toResumeMap', () => {
    const state = stateWith([
        { id: 'i1', names: ['execute_command', 'execute_command'] },
        { id: 'i2', names: ['ask_user'] },
    ]);
    const pending = pendingActions(state);

    it('groups decisions by interrupt id, positional within each', () => {
        const r = toResumeMap(pending, [
            { toolCallId: 'i1#0', approved: true },
            { toolCallId: 'i1#1', approved: false, reason: 'too broad' },
            { toolCallId: 'i2#0', approved: true, answer: 'us-east-1' },
        ]);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(Object.keys(r.resume).sort()).toEqual(['i1', 'i2']);
        expect(r.resume.i1.decisions).toEqual([
            { type: 'approve' },
            { type: 'reject', message: 'Rejected by user — reason: too broad. Do not retry this exact action; adapt or ask.' },
        ]);
        expect(r.resume.i2.decisions).toEqual([{ type: 'respond', message: 'us-east-1' }]);
    });

    it('keeps positions correct when decisions arrive out of order', () => {
        const r = toResumeMap(pending, [
            { toolCallId: 'i2#0', approved: true, answer: 'x' },
            { toolCallId: 'i1#1', approved: true },
            { toolCallId: 'i1#0', approved: false, reason: 'no' },
        ]);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.resume.i1.decisions[0].type).toBe('reject');
        expect(r.resume.i1.decisions[1].type).toBe('approve');
    });

    it('turns a declined ask_user into guidance rather than failing', () => {
        const r = toResumeMap(pending, [
            { toolCallId: 'i1#0', approved: true },
            { toolCallId: 'i1#1', approved: true },
            { toolCallId: 'i2#0', approved: false },
        ]);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.resume.i2.decisions[0]).toEqual({
            type: 'respond',
            message: 'The user declined to answer. Proceed with your best judgment or finish and state the open question.',
        });
    });

    it('errors when any pending action has no decision', () => {
        const r = toResumeMap(pending, [{ toolCallId: 'i1#0', approved: true }]);
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error).toContain('Undecided tool call(s)');
    });

    it('errors on an unknown toolCallId', () => {
        const r = toResumeMap(pending, [
            { toolCallId: 'i1#0', approved: true },
            { toolCallId: 'i1#1', approved: true },
            { toolCallId: 'i2#0', approved: true, answer: 'x' },
            { toolCallId: 'nope#0', approved: true },
        ]);
        expect(r).toEqual({ ok: false, error: 'Unknown toolCallId(s): nope#0' });
    });

    it('errors when an approved ask_user has an empty answer', () => {
        const r = toResumeMap(pending, [
            { toolCallId: 'i1#0', approved: true },
            { toolCallId: 'i1#1', approved: true },
            { toolCallId: 'i2#0', approved: true, answer: '   ' },
        ]);
        expect(r).toEqual({ ok: false, error: 'ask_user (i2#0) requires a non-empty answer.' });
    });

    it('produces ids that round-trip back to their interrupt and position', () => {
        expect(actionId('abc', 3)).toBe('abc#3');
        const [p] = pendingActions(stateWith([{ id: 'has#hash', names: ['execute_command'] }]));
        expect(p.interruptId).toBe('has#hash');
        expect(p.index).toBe(0);
    });
});

// Regression: every decision we emit must be one the installed middleware accepts.
// 'respond' is documented and supplied by patches/langchain@1.5.2.patch; shipping a
// type outside this set fails at runtime with "Decision type ... is not allowed".
describe('decision types match the middleware contract', () => {
    const contractPending = pendingActions(stateWith([
        { id: 'i1', names: ['execute_command', 'execute_command'] },
        { id: 'i2', names: ['ask_user'] },
    ]));
    it('never emits a decision type outside approve|edit|reject', () => {
        const r = toResumeMap(contractPending, [
            { toolCallId: 'i1#0', approved: true },
            { toolCallId: 'i1#1', approved: false, reason: 'no' },
            { toolCallId: 'i2#0', approved: true, answer: 'us-east-1' },
        ]);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const types = Object.values(r.resume).flatMap(v => v.decisions.map(d => d.type));
        expect(types.length).toBeGreaterThan(0);
        for (const t of types) expect(['approve', 'edit', 'reject', 'respond']).toContain(t);
    });
});

// Regression: a LangGraph interrupt id is XXH3(task namespace) — no round counter — so a task
// that pauses AGAIN after being resumed reuses the SAME id. With ids of the form
// `${interruptId}#${index}` the second round collided 1:1 with the first: the client showed those
// cards as already "approved", "Approve remaining" submitted only the rest, and the resume was
// rejected with "Undecided tool call(s)". Measured on thread 1786530106547 — 18 decided, then 22
// offered of which 14 reused the prior round's ids.
describe('action ids are unique per approval round', () => {
    const withCheckpoint = (checkpointId: string) => ({
        ...stateWith([{ id: 'ee5e43a2', names: ['execute_command', 'execute_command'] }]),
        config: { configurable: { checkpoint_id: checkpointId } },
    });

    it('gives the same interrupt different action ids in different rounds', () => {
        const round1 = pendingActions(withCheckpoint('ckpt-1')).map(a => a.toolCallId);
        const round2 = pendingActions(withCheckpoint('ckpt-2')).map(a => a.toolCallId);
        expect(round1).toHaveLength(2);
        expect(round2).toHaveLength(2);
        for (const id of round1) expect(round2).not.toContain(id);
    });

    it('still resolves back to the raw interrupt id and index for the resume map', () => {
        const pending = pendingActions(withCheckpoint('ckpt-1'));
        const r = toResumeMap(pending, pending.map(p => ({ toolCallId: p.toolCallId, approved: true })) as never);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(Object.keys(r.resume)).toEqual(['ee5e43a2']);
        expect(r.resume.ee5e43a2.decisions).toEqual([{ type: 'approve' }, { type: 'approve' }]);
    });

    it('works when the state carries no checkpoint id', () => {
        const pending = pendingActions(stateWith([{ id: 'i1', names: ['execute_command'] }]));
        expect(pending[0].toolCallId).toBe('i1#0');
        expect(pending[0].interruptId).toBe('i1');
    });
});

