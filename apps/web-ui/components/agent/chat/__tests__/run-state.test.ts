import { describe, it, expect } from 'vitest';
import { deriveRunState, computeToolPartVisibility, isRejectedToolResult } from '../run-state';

const msg = (parts: Array<{ type: string; data?: unknown; text?: string }>) =>
    ({ role: 'assistant', parts });

const msgWithId = (id: string, parts: Array<Record<string, unknown> & { type: string }>) =>
    ({ role: 'assistant', id, parts });

const subagentPart = (data: Record<string, unknown>) => ({ type: 'data-subagent', data });

describe('deriveRunState', () => {
    it('takes the LAST data-plan part as the live plan', () => {
        const rs = deriveRunState([
            msg([
                { type: 'data-plan', data: { steps: [{ step: 'a', status: 'pending' }], updatedBy: 'planner' } },
                { type: 'data-plan', data: { steps: [{ step: 'a', status: 'completed' }], updatedBy: 'reflect' } },
            ]),
        ] as any, new Set());
        expect(rs.plan).toEqual([{ step: 'a', status: 'completed' }]);
        expect(rs.planUpdatedBy).toBe('reflect');
        expect(rs.hasStructuredData).toBe(true);
    });

    it('tracks current phase from the last data-phase part', () => {
        const rs = deriveRunState([
            msg([
                { type: 'data-phase', data: { phase: 'planning', node: 'planner', ts: 1 } },
                { type: 'data-phase', data: { phase: 'execution', node: 'generate', ts: 2 } },
            ]),
        ] as any, new Set());
        expect(rs.currentPhase).toBe('execution');
        expect(rs.phases).toHaveLength(2);
    });

    it('surfaces pending approvals and clarifications, filtering resolved ids', () => {
        const rs = deriveRunState([
            msg([
                { type: 'data-approval', data: { batchId: 'b1', tools: [
                    { toolCallId: 't1', toolName: 'execute_command', args: {}, guard: null },
                    { toolCallId: 't2', toolName: 'write_file', args: {}, guard: { toolCallId: 't2', toolName: 'write_file', isMutative: true, severity: 'MEDIUM', action: '', blastRadius: '', reversible: true, saferPath: '' } },
                ] } },
                { type: 'data-clarification', data: { toolCallId: 't3', question: 'which?', options: ['a'] } },
            ]),
        ] as any, new Set(['t1']));
        expect(rs.pendingApproval!.tools.map(t => t.toolCallId)).toEqual(['t2']);
        expect(rs.pendingClarifications).toHaveLength(1);
    });

    it('clears pendingApproval entirely when all its tools are resolved', () => {
        const rs = deriveRunState([
            msg([{ type: 'data-approval', data: { batchId: 'b1', tools: [{ toolCallId: 't1', toolName: 'x', args: {}, guard: null }] } }]),
        ] as any, new Set(['t1']));
        expect(rs.pendingApproval).toBeNull();
    });

    it('legacy thread (no data parts) → hasStructuredData false, empty plan', () => {
        const rs = deriveRunState([msg([{ type: 'reasoning', text: 'PLANNING_PHASE_START\nsteps…' }])] as any, new Set());
        expect(rs.hasStructuredData).toBe(false);
        expect(rs.plan).toEqual([]);
    });

    it('mixed batch, SERVER-TRUE order (data-approval then data-clarification in the SAME message) — both survive', () => {
        const rs = deriveRunState([
            msg([
                { type: 'data-approval', data: { batchId: 'b1', tools: [{ toolCallId: 't1', toolName: 'execute_command', args: {}, guard: null }] } },
                { type: 'data-clarification', data: { toolCallId: 't2', question: 'which region?', options: ['us-east-1'] } },
            ]),
        ] as any, new Set());
        expect(rs.pendingApproval!.tools.map(t => t.toolCallId)).toEqual(['t1']);
        expect(rs.pendingClarifications).toHaveLength(1);
        expect(rs.pendingClarifications[0].toolCallId).toBe('t2');
    });

    it('only the LAST data-approval batch counts (earlier batches are history)', () => {
        const rs = deriveRunState([
            msg([{ type: 'data-approval', data: { batchId: 'b1', tools: [{ toolCallId: 't1', toolName: 'x', args: {}, guard: null }] } }]),
            msg([{ type: 'data-approval', data: { batchId: 'b2', tools: [{ toolCallId: 't9', toolName: 'y', args: {}, guard: null }] } }]),
        ] as any, new Set());
        expect(rs.pendingApproval!.batchId).toBe('b2');
    });

    it('hasApprovalData is true when any data-approval part exists, even if all its tools are resolved', () => {
        const rs = deriveRunState([
            msg([{ type: 'data-approval', data: { batchId: 'b1', tools: [{ toolCallId: 't1', toolName: 'x', args: {}, guard: null }] } }]),
        ] as any, new Set(['t1']));
        expect(rs.pendingApproval).toBeNull();
        expect(rs.hasApprovalData).toBe(true);
    });

    it('an empty-tools data-approval (ask_user-only interrupt) supersedes the previous batch — no ghost approval, clarification pending (round-5 regression)', () => {
        const rs = deriveRunState([
            // Turn N: real batch (its tool was rejected server-side; parts may lack output pre-fix)
            msg([{ type: 'data-approval', data: { batchId: 'b1', tools: [{ toolCallId: 't1', toolName: 'execute_command', args: {}, guard: null }] } }]),
            // Turn N+1: ask_user-only interrupt → empty-tools batch + clarification
            msg([
                { type: 'data-approval', data: { batchId: 'b2', tools: [] } },
                { type: 'data-clarification', data: { toolCallId: 't9', question: 'Proceed how?', options: ['a', 'b'] } },
            ]),
        ] as any, new Set());
        expect(rs.pendingApproval).toBeNull();
        expect(rs.pendingClarifications.map(c => c.toolCallId)).toEqual(['t9']);
    });

    it('a data-approval tool with an output-bearing tool part ANYWHERE is not pending (executed-id defense)', () => {
        const rs = deriveRunState([
            msgWithId('m1', [
                { type: 'data-approval', data: { batchId: 'b1', tools: [
                    { toolCallId: 't1', toolName: 'execute_command', args: {}, guard: null },
                    { toolCallId: 't2', toolName: 'write_file', args: {}, guard: null },
                ] } },
            ]),
            // t1 already produced a result (e.g. synthetic rejection part on resume)
            msgWithId('m2', [{ type: 'tool-execute_command', toolCallId: 't1', input: {}, output: 'Rejected by user.', state: 'output-available' }]),
        ] as any, new Set());
        expect(rs.pendingApproval!.tools.map(t => t.toolCallId)).toEqual(['t2']);
    });

    it('pendingApproval clears entirely when ALL its tools have output-bearing parts', () => {
        const rs = deriveRunState([
            msgWithId('m1', [{ type: 'data-approval', data: { batchId: 'b1', tools: [{ toolCallId: 't1', toolName: 'x', args: {}, guard: null }] } }]),
            msgWithId('m2', [{ type: 'tool-x', toolCallId: 't1', input: {}, result: 'done' }]),
        ] as any, new Set());
        expect(rs.pendingApproval).toBeNull();
    });

    it('a clarification whose toolCallId has an output-bearing part is filtered (answered ask_user cannot resurrect)', () => {
        const rs = deriveRunState([
            msgWithId('m1', [{ type: 'data-clarification', data: { toolCallId: 't3', question: 'which?', options: [] } }]),
            msgWithId('m2', [{ type: 'tool-ask_user', toolCallId: 't3', input: { question: 'which?' }, output: 'us-east-1', state: 'output-available' }]),
        ] as any, new Set());
        expect(rs.pendingClarifications).toEqual([]);
    });

    it('an input-only tool part (state input-available, no output) does NOT mark its id executed', () => {
        const rs = deriveRunState([
            msgWithId('m1', [
                { type: 'data-approval', data: { batchId: 'b1', tools: [{ toolCallId: 't1', toolName: 'x', args: {}, guard: null }] } },
                { type: 'tool-x', toolCallId: 't1', input: {}, state: 'input-available' },
            ]),
        ] as any, new Set());
        expect(rs.pendingApproval!.tools.map(t => t.toolCallId)).toEqual(['t1']);
    });

    it('hasApprovalData is false without any data-approval part (other data parts do not count)', () => {
        const rs = deriveRunState([
            msg([
                { type: 'data-phase', data: { phase: 'execution', node: 'generate', ts: 1 } },
                { type: 'data-clarification', data: { toolCallId: 't1', question: 'q', options: [] } },
            ]),
        ] as any, new Set());
        expect(rs.hasApprovalData).toBe(false);
        expect(rs.hasStructuredData).toBe(true);
    });
});

describe('computeToolPartVisibility', () => {
    const toolPart = (toolCallId: string, extra: Record<string, unknown> = {}) =>
        ({ type: 'tool-execute_command', toolCallId, input: { command: 'ls' }, ...extra });

    it('single part wins (maps to its own message)', () => {
        const vis = computeToolPartVisibility([msgWithId('m1', [toolPart('t1')])] as any);
        expect(vis.get('t1')).toBe('m1');
    });

    it('input-only old part + resumed part WITH output → the resumed part wins', () => {
        const vis = computeToolPartVisibility([
            msgWithId('m1', [toolPart('t1')]),
            msgWithId('m2', [toolPart('t1', { output: 'done', state: 'output-available' })]),
        ] as any);
        expect(vis.get('t1')).toBe('m2');
    });

    it('a part with output is never displaced by a later input-only part', () => {
        const vis = computeToolPartVisibility([
            msgWithId('m1', [toolPart('t1', { result: 'done' })]),
            msgWithId('m2', [toolPart('t1')]),
        ] as any);
        expect(vis.get('t1')).toBe('m1');
    });

    it('input-only old + resumed input-only (no output yet) → the LATER part wins', () => {
        const vis = computeToolPartVisibility([
            msgWithId('m1', [toolPart('t1')]),
            msgWithId('m2', [toolPart('t1')]),
        ] as any);
        expect(vis.get('t1')).toBe('m2');
    });

    it('independent toolCallIds are unaffected by each other', () => {
        const vis = computeToolPartVisibility([
            msgWithId('m1', [toolPart('t1'), toolPart('t2', { output: 'ok' })]),
            msgWithId('m2', [toolPart('t1', { output: 'done' })]),
        ] as any);
        expect(vis.get('t1')).toBe('m2');
        expect(vis.get('t2')).toBe('m1');
    });

    it('parts without a toolCallId and non-tool parts are ignored', () => {
        const vis = computeToolPartVisibility([
            msgWithId('m1', [
                { type: 'text', text: 'hello' },
                { type: 'reasoning', text: 'thinking' },
                { type: 'text', toolCallId: 't-text' }, // text part never counts even with an id
                { type: 'tool-execute_command', input: {} }, // no toolCallId
            ]),
        ] as any);
        expect(vis.size).toBe(0);
    });

    it('non-assistant messages are skipped', () => {
        const vis = computeToolPartVisibility([
            { role: 'user', id: 'u1', parts: [toolPart('t1')] },
            msgWithId('m1', [toolPart('t1')]),
        ] as any);
        expect(vis.get('t1')).toBe('m1');
    });
});

describe('isRejectedToolResult', () => {
    it('detects the synthetic server rejection output (with and without reason)', () => {
        expect(isRejectedToolResult('Rejected by user. Do not retry this exact action; adapt or ask.')).toBe(true);
        expect(isRejectedToolResult('Rejected by user — reason: too risky. Do not retry this exact action; adapt or ask.')).toBe(true);
    });

    it('detects a local batch-card rejection decision even before any output exists', () => {
        expect(isRejectedToolResult(undefined, { approved: false })).toBe(true);
        expect(isRejectedToolResult(null, { approved: false, answer: 'nope' })).toBe(true);
        // Decision wins regardless of what the (stale) result says
        expect(isRejectedToolResult('ok', { approved: false })).toBe(true);
    });

    it('approved decisions and normal outputs are not rejections', () => {
        expect(isRejectedToolResult('command output', { approved: true })).toBe(false);
        expect(isRejectedToolResult('command output')).toBe(false);
        expect(isRejectedToolResult(undefined)).toBe(false);
        expect(isRejectedToolResult(undefined, { approved: true })).toBe(false);
    });

    it('does not match rejection text mid-string or non-string results', () => {
        expect(isRejectedToolResult('The call was Rejected by user earlier')).toBe(false);
        expect(isRejectedToolResult({ text: 'Rejected by user' })).toBe(false);
        expect(isRejectedToolResult(['Rejected by user'])).toBe(false);
    });
});

describe('deriveRunState token usage', () => {
    const asst = (parts: any[]) => ({ role: 'assistant', id: 'm', parts });

    it('sums data-usage parts across the thread', () => {
        const state = deriveRunState([
            asst([
                { type: 'data-usage', data: { input: 100, output: 20 } },
                { type: 'data-usage', data: { input: 50, output: 10 } },
            ]),
            asst([{ type: 'data-usage', data: { input: 5, output: 1 } }]),
        ], new Set());
        expect(state.tokenUsage).toEqual({ input: 155, output: 31 });
    });

    it('defaults to zero when there are no data-usage parts', () => {
        const state = deriveRunState([asst([{ type: 'text', text: 'hi' }])], new Set());
        expect(state.tokenUsage).toEqual({ input: 0, output: 0 });
    });
});

describe('deriveRunState — subagents', () => {
    it('collects sub-agents in first-seen order', () => {
        const state = deriveRunState([msg([
            subagentPart({ id: 'a', role: 'A', task: 't', status: 'running', toolCount: 0, tokensIn: 0, tokensOut: 0 }),
            subagentPart({ id: 'b', role: 'B', task: 't', status: 'running', toolCount: 0, tokensIn: 0, tokensOut: 0 }),
        ])] as any, new Set());

        expect(state.subagents.map(s => s.id)).toEqual(['a', 'b']);
    });

    it('replaces an earlier update for the same id rather than duplicating', () => {
        const state = deriveRunState([msg([
            subagentPart({ id: 'a', role: 'A', task: 't', status: 'running', toolCount: 1, tokensIn: 10, tokensOut: 2 }),
            subagentPart({ id: 'a', role: 'A', task: 't', status: 'done', toolCount: 5, tokensIn: 900, tokensOut: 80, summary: 'found it' }),
        ])] as any, new Set());

        expect(state.subagents).toHaveLength(1);
        expect(state.subagents[0]).toMatchObject({ status: 'done', toolCount: 5, summary: 'found it' });
    });

    it('marks the run as having structured data', () => {
        const state = deriveRunState([msg([
            subagentPart({ id: 'a', role: 'A', task: 't', status: 'running', toolCount: 0, tokensIn: 0, tokensOut: 0 }),
        ])] as any, new Set());

        expect(state.hasStructuredData).toBe(true);
    });

    it('returns an empty list when no sub-agent parts are present', () => {
        expect(deriveRunState([msg([{ type: 'text', text: 'hi' }])] as any, new Set()).subagents).toEqual([]);
    });
});
