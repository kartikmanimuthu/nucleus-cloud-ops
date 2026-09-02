import { describe, it, expect, vi, beforeEach } from 'vitest';

const getRun = vi.fn();
const recordEvent = vi.fn().mockResolvedValue(undefined);
const resumeDeepRun = vi.fn().mockResolvedValue(undefined);
const logUserAction = vi.fn().mockResolvedValue(undefined);

vi.mock('@/lib/agent-ops/agent-ops-service', () => ({
    agentOpsService: { getRun: (...a: unknown[]) => getRun(...a), recordEvent: (...a: unknown[]) => recordEvent(...a) },
}));
vi.mock('@/lib/agent-ops/deep-run-executor', () => ({ resumeDeepRun: (...a: unknown[]) => resumeDeepRun(...a) }));
vi.mock('@/lib/auth-session', () => ({
    getSessionTenantId: async () => 't1',
    getAuthSession: async () => ({ user: { email: 'a@b.c' } }),
}));
vi.mock('@/lib/gateway/event-bus', () => ({ getGatewayEventBus: () => ({ emit: vi.fn() }) }));
vi.mock('@/lib/gateway', () => ({ getGatewayService: () => ({}) }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: (...a: unknown[]) => logUserAction(...a) } }));

import { POST } from './route';

const pendingActions = [
    { toolCallId: 'ck:i1#0', toolName: 'execute_command', args: { command: 'ls' }, interruptId: 'i1', index: 0 },
    { toolCallId: 'ck:i1#1', toolName: 'write_file', args: { path: '/a' }, interruptId: 'i1', index: 1 },
];

const awaitingRun = {
    runId: 'r1', tenantId: 't1', mode: 'deep', status: 'awaiting_approval', threadId: 'th1',
    approvalRequest: { planSteps: [], approvalType: 'deep_actions', pendingActions },
};

const req = (body: unknown) => new Request('http://x/api', { method: 'POST', body: JSON.stringify(body) });
const params = Promise.resolve({ runId: 'r1' });

describe('POST /api/agent-ops/[runId]/decisions', () => {
    beforeEach(() => { vi.clearAllMocks(); getRun.mockResolvedValue(awaitingRun); });

    it('declares the approve permission on the AgentOps subject', async () => {
        const mod = await import('./route');
        expect(mod.authz.POST).toEqual({ action: 'approve', subject: 'AgentOps' });
    });

    it('resumes when every pending action has a decision', async () => {
        const res = await POST(req({ decisions: [
            { toolCallId: 'ck:i1#0', approved: true },
            { toolCallId: 'ck:i1#1', approved: true },
        ] }), { params });
        expect(res.status).toBe(200);
        expect(resumeDeepRun).toHaveBeenCalledTimes(1);
        const map = resumeDeepRun.mock.calls[0][1];
        expect(map.i1.decisions).toEqual([{ type: 'approve' }, { type: 'approve' }]);
        // Both actions were approved and neither is ask_user — no synthetic
        // tool_result should be recorded, since both will actually execute.
        expect(recordEvent).not.toHaveBeenCalled();
    });

    it('rejects a partial decision set', async () => {
        const res = await POST(req({ decisions: [{ toolCallId: 'ck:i1#0', approved: true }] }), { params });
        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toMatchObject({ error: expect.stringMatching(/Undecided/) });
        expect(resumeDeepRun).not.toHaveBeenCalled();
        // A partial batch must be refused BEFORE any side effect — no synthetic
        // events recorded, no resume attempted, nothing half-applied.
        expect(recordEvent).not.toHaveBeenCalled();
    });

    it('rejects an unknown toolCallId', async () => {
        const res = await POST(req({ decisions: [
            { toolCallId: 'ck:i1#0', approved: true },
            { toolCallId: 'ck:i1#1', approved: true },
            { toolCallId: 'bogus', approved: true },
        ] }), { params });
        expect(res.status).toBe(400);
        expect(resumeDeepRun).not.toHaveBeenCalled();
        expect(recordEvent).not.toHaveBeenCalled();
    });

    it('turns a rejection into a reject decision carrying the reason', async () => {
        const res = await POST(req({ decisions: [
            { toolCallId: 'ck:i1#0', approved: false, reason: 'too risky' },
            { toolCallId: 'ck:i1#1', approved: true },
        ] }), { params });
        expect(res.status).toBe(200);
        const map = resumeDeepRun.mock.calls[0][1];
        expect(map.i1.decisions[0].type).toBe('reject');
        expect(map.i1.decisions[0].message).toContain('too risky');
        // Only the rejected action (never executes) gets a synthetic tool_result;
        // the approved one is left for the real tools node to settle.
        expect(recordEvent).toHaveBeenCalledTimes(1);
        expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({
            runId: 'r1',
            tenantId: 't1',
            eventType: 'tool_result',
            toolName: 'execute_command',
            toolOutput: expect.stringContaining('too risky'),
            metadata: expect.objectContaining({ toolCallId: 'ck:i1#0', synthetic: true }),
        }));
        // Audit trail must be tagged consistently with every other agent-ops
        // route (AgentOps, not a lowercase/singular one-off) — this is the
        // resourceType half of the same subject-drift bug class as authz.POST.
        expect(logUserAction).toHaveBeenCalledWith(expect.objectContaining({ resourceType: 'AgentOps' }));
    });

    it('409s when the run is not awaiting approval', async () => {
        getRun.mockResolvedValue({ ...awaitingRun, status: 'in_progress' });
        const res = await POST(req({ decisions: [] }), { params });
        expect(res.status).toBe(409);
    });

    it('409s for a non-deep run', async () => {
        getRun.mockResolvedValue({ ...awaitingRun, mode: 'plan' });
        const res = await POST(req({ decisions: [] }), { params });
        expect(res.status).toBe(409);
    });

    it('403s when the run does not belong to the session tenant', async () => {
        getRun.mockResolvedValue(null);
        const res = await POST(req({ decisions: [] }), { params });
        expect(res.status).toBe(403);
        // Ownership must be enforced via the SESSION tenant, not anything
        // client-supplied — getRun is called with the session tenant id ('t1')
        // scoping the lookup, so a run belonging to another tenant is invisible.
        expect(getRun).toHaveBeenCalledWith('t1', 'r1');
        expect(resumeDeepRun).not.toHaveBeenCalled();
    });

    it('400s when decisions is not an array', async () => {
        const res = await POST(req({ decisions: 'nope' }), { params });
        expect(res.status).toBe(400);
    });
});
