import { describe, it, expect, vi, beforeEach } from 'vitest';

const getRun = vi.fn();
const recordEvent = vi.fn().mockResolvedValue(undefined);
const updateRunStatus = vi.fn().mockResolvedValue(undefined);
const resumeApprovedRun = vi.fn().mockResolvedValue(undefined);
const resumeDeepRun = vi.fn().mockResolvedValue(undefined);
const logUserAction = vi.fn().mockResolvedValue(undefined);
const finalizeScheduledRun = vi.fn().mockResolvedValue(undefined);
const emit = vi.fn();

vi.mock('@/lib/agent-ops/agent-ops-service', () => ({
    agentOpsService: {
        getRun: (...a: unknown[]) => getRun(...a),
        recordEvent: (...a: unknown[]) => recordEvent(...a),
        updateRunStatus: (...a: unknown[]) => updateRunStatus(...a),
    },
}));
vi.mock('@/lib/agent-ops/agent-executor', () => ({ resumeApprovedRun: (...a: unknown[]) => resumeApprovedRun(...a) }));
vi.mock('@/lib/agent-ops/deep-run-executor', () => ({ resumeDeepRun: (...a: unknown[]) => resumeDeepRun(...a) }));
vi.mock('@/lib/agent-ops/scheduled-notifier', () => ({ finalizeScheduledRun: (...a: unknown[]) => finalizeScheduledRun(...a) }));
vi.mock('@/lib/auth-session', () => ({
    getSessionTenantId: async () => 't1',
    getAuthSession: async () => ({ user: { email: 'a@b.c' } }),
}));
vi.mock('@/lib/gateway/event-bus', () => ({ getGatewayEventBus: () => ({ emit: (...a: unknown[]) => emit(...a) }) }));
vi.mock('@/lib/gateway', () => ({ getGatewayService: () => ({}) }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: (...a: unknown[]) => logUserAction(...a) } }));

import { POST } from './route';

const pendingActions = [
    { toolCallId: 'ck:i1#0', toolName: 'execute_command', args: { command: 'ls' }, interruptId: 'i1', index: 0 },
    { toolCallId: 'ck:i1#1', toolName: 'write_file', args: { path: '/a' }, interruptId: 'i1', index: 1 },
];

const deepAwaitingRun = {
    runId: 'r1', tenantId: 't1', mode: 'deep', status: 'awaiting_approval', threadId: 'th1',
    approvalRequest: { planSteps: [], approvalType: 'deep_actions', pendingActions },
};

const planAwaitingRun = {
    runId: 'r1', tenantId: 't1', mode: 'plan', status: 'awaiting_approval', threadId: 'th1',
};

const req = (body: unknown) => new Request('http://x/api', { method: 'POST', body: JSON.stringify(body) });
const params = Promise.resolve({ runId: 'r1' });

describe('POST /api/agent-ops/[runId]/approve', () => {
    beforeEach(() => { vi.clearAllMocks(); getRun.mockResolvedValue(deepAwaitingRun); });

    it('declares the approve permission on the AgentOps subject', async () => {
        const mod = await import('./route');
        expect(mod.authz.POST).toEqual({ action: 'approve', subject: 'AgentOps' });
    });

    it('400s on an invalid action, before any run lookup', async () => {
        const res = await POST(req({ action: 'nope' }), { params });
        expect(res.status).toBe(400);
        expect(getRun).not.toHaveBeenCalled();
    });

    it('403s when the run does not belong to the session tenant', async () => {
        getRun.mockResolvedValue(null);
        const res = await POST(req({ action: 'approve' }), { params });
        expect(res.status).toBe(403);
    });

    it('409s when the run is not awaiting approval', async () => {
        getRun.mockResolvedValue({ ...deepAwaitingRun, status: 'in_progress' });
        const res = await POST(req({ action: 'approve' }), { params });
        expect(res.status).toBe(409);
    });

    it('500s when a dependency throws', async () => {
        getRun.mockRejectedValue(new Error('DB down'));
        const res = await POST(req({ action: 'approve' }), { params });
        expect(res.status).toBe(500);
    });

    describe('deep mode', () => {
        it('approve fans the verdict out across every pending action and resumes — no terminal event, no synthetic results', async () => {
            const res = await POST(req({ action: 'approve' }), { params });
            expect(res.status).toBe(200);

            expect(resumeDeepRun).toHaveBeenCalledTimes(1);
            const [resumedRun, map] = resumeDeepRun.mock.calls[0];
            expect(resumedRun).toBe(deepAwaitingRun);
            expect(map.i1.decisions).toEqual([{ type: 'approve' }, { type: 'approve' }]);

            // Exactly one bookkeeping event, and it must NOT be a terminal 'final' —
            // the run is resuming, not ending.
            expect(recordEvent).toHaveBeenCalledTimes(1);
            expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({
                runId: 'r1', tenantId: 't1', eventType: 'planning', node: 'deep_approval_gate',
            }));
            expect(recordEvent).not.toHaveBeenCalledWith(expect.objectContaining({ eventType: 'final' }));

            expect(logUserAction).toHaveBeenCalledWith(expect.objectContaining({
                eventType: 'agent.run.approved', resourceType: 'AgentOps',
            }));
        });

        it('reject fans the verdict out, resumes, writes a synthetic tool_result per pending action, and never writes a terminal final', async () => {
            const res = await POST(req({ action: 'reject' }), { params });
            expect(res.status).toBe(200);

            expect(resumeDeepRun).toHaveBeenCalledTimes(1);
            const [, map] = resumeDeepRun.mock.calls[0];
            expect(map.i1.decisions[0].type).toBe('reject');
            expect(map.i1.decisions[1].type).toBe('reject');

            // One bookkeeping 'planning' event + one synthetic tool_result per
            // pending action (both rejected here, so both get one).
            expect(recordEvent).toHaveBeenCalledTimes(1 + pendingActions.length);
            expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({
                runId: 'r1', tenantId: 't1', eventType: 'planning', node: 'deep_approval_gate',
            }));
            for (const action of pendingActions) {
                expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({
                    runId: 'r1', tenantId: 't1', eventType: 'tool_result', node: 'tools',
                    toolName: action.toolName,
                    metadata: expect.objectContaining({ toolCallId: action.toolCallId, synthetic: true }),
                }));
            }

            // The critical regression: a rejection RESUMES the graph, so it must
            // never be logged as a terminal 'final' event (that would render a
            // spurious mid-run "Final summary" ahead of the real one).
            expect(recordEvent).not.toHaveBeenCalledWith(expect.objectContaining({ eventType: 'final' }));

            expect(logUserAction).toHaveBeenCalledWith(expect.objectContaining({
                eventType: 'agent.run.rejected', resourceType: 'AgentOps',
            }));

            // Deep reject is a resume, not a cancellation — plan-mode's
            // updateRunStatus('cancelled') path must not run here.
            expect(updateRunStatus).not.toHaveBeenCalled();
        });

        it('409s when the deep run has no pending actions recorded', async () => {
            getRun.mockResolvedValue({ ...deepAwaitingRun, approvalRequest: { planSteps: [], approvalType: 'deep_actions', pendingActions: [] } });
            const res = await POST(req({ action: 'approve' }), { params });
            expect(res.status).toBe(409);
            expect(resumeDeepRun).not.toHaveBeenCalled();
        });
    });

    describe('plan mode', () => {
        beforeEach(() => { getRun.mockResolvedValue(planAwaitingRun); });

        it('approve resumes via resumeApprovedRun and never touches the deep path', async () => {
            const res = await POST(req({ action: 'approve' }), { params });
            expect(res.status).toBe(200);
            expect(resumeApprovedRun).toHaveBeenCalledTimes(1);
            expect(resumeApprovedRun).toHaveBeenCalledWith(planAwaitingRun, expect.objectContaining({ emit: expect.any(Function) }));
            expect(resumeDeepRun).not.toHaveBeenCalled();
            expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'planning', node: 'approval_gate' }));
            expect(await res.json()).toEqual({ runId: 'r1', status: 'in_progress', message: 'Run approved — resuming execution.' });
            expect(logUserAction).toHaveBeenCalledWith(expect.objectContaining({
                eventType: 'agent.run.approved', severity: 'high',
            }));
        });

        it('reject cancels the run and writes a terminal final event (unchanged plan-mode behaviour)', async () => {
            const res = await POST(req({ action: 'reject' }), { params });
            expect(res.status).toBe(200);
            expect(updateRunStatus).toHaveBeenCalledWith('t1', 'r1', 'cancelled');
            expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'final', node: 'approval_gate' }));
            expect(resumeApprovedRun).not.toHaveBeenCalled();
            expect(resumeDeepRun).not.toHaveBeenCalled();

            // The source channel is notified through the bus, and a scheduled
            // task's digest still has to be delivered — without re-counting the
            // run, which the trigger route already did at first settle.
            expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'run:cancelled', runId: 'r1' }));
            expect(finalizeScheduledRun).toHaveBeenCalledWith(
                expect.objectContaining({ runId: 'r1', status: 'cancelled' }), { countRun: false },
            );
            expect(await res.json()).toEqual({ runId: 'r1', status: 'cancelled', message: 'Run rejected.' });
            expect(logUserAction).toHaveBeenCalledWith(expect.objectContaining({
                eventType: 'agent.run.rejected', severity: 'medium',
            }));
        });
    });
});
