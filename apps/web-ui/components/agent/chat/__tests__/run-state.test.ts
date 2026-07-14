import { describe, it, expect } from 'vitest';
import { deriveRunState, computeToolPartVisibility } from '../run-state';

const msg = (parts: Array<{ type: string; data?: unknown; text?: string }>) =>
    ({ role: 'assistant', parts });

const msgWithId = (id: string, parts: Array<Record<string, unknown> & { type: string }>) =>
    ({ role: 'assistant', id, parts });

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
