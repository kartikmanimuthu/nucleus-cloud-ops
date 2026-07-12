import { describe, it, expect } from 'vitest';
import { deriveRunState } from '../run-state';

const msg = (parts: Array<{ type: string; data?: unknown; text?: string }>) =>
    ({ role: 'assistant', parts });

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
});
