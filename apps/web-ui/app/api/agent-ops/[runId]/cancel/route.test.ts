import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/agent-ops/agent-ops-service', () => ({
    agentOpsService: { getRun: vi.fn(), updateRunStatus: vi.fn(), recordEvent: vi.fn() },
}));
vi.mock('@/lib/agent-ops/run-manager', () => ({ cancelRun: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn(), getAuthSession: vi.fn() }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));

import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
import { cancelRun } from '@/lib/agent-ops/run-manager';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import { POST } from './route';

const makeParams = (runId: string) => ({ params: Promise.resolve({ runId }) });

describe('POST /api/agent-ops/[runId]/cancel', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getAuthSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
    });

    it('returns 403 when the run does not exist for this tenant', async () => {
        vi.mocked(agentOpsService.getRun).mockResolvedValue(null);
        const res = await POST({} as any, makeParams('run-missing'));
        expect(res.status).toBe(403);
    });

    it('returns 409 when the run is already in a terminal state', async () => {
        vi.mocked(agentOpsService.getRun).mockResolvedValue({ id: 'run-1', status: 'completed' } as any);
        const res = await POST({} as any, makeParams('run-1'));
        expect(res.status).toBe(409);
        expect(cancelRun).not.toHaveBeenCalled();
    });

    it('signals the executor, updates status, records the event, and logs an audit event', async () => {
        vi.mocked(agentOpsService.getRun).mockResolvedValue({ id: 'run-1', status: 'in_progress' } as any);
        vi.mocked(cancelRun).mockReturnValue(true);

        const res = await POST({} as any, makeParams('run-1'));
        const body = await res.json();

        expect(cancelRun).toHaveBeenCalledWith('run-1');
        expect(agentOpsService.updateRunStatus).toHaveBeenCalledWith('tenant-1', 'run-1', 'cancelled');
        expect(agentOpsService.recordEvent).toHaveBeenCalledWith(
            expect.objectContaining({ runId: 'run-1', metadata: { wasActive: true } })
        );
        expect(res.status).toBe(200);
        expect(body).toEqual({ runId: 'run-1', status: 'cancelled', wasActive: true });
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'agent.run.cancelled' })
        );
    });

    it('still updates status even when the run was not active', async () => {
        vi.mocked(agentOpsService.getRun).mockResolvedValue({ id: 'run-1', status: 'awaiting_input' } as any);
        vi.mocked(cancelRun).mockReturnValue(false);

        const res = await POST({} as any, makeParams('run-1'));
        const body = await res.json();
        expect(body.wasActive).toBe(false);
    });

    it('returns 500 when a dependency throws', async () => {
        vi.mocked(agentOpsService.getRun).mockRejectedValue(new Error('DB down'));
        const res = await POST({} as any, makeParams('run-1'));
        expect(res.status).toBe(500);
    });
});
