import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/agent-ops/agent-ops-service', () => ({
    agentOpsService: { getRun: vi.fn(), getRunEvents: vi.fn() },
}));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));

import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
import { getSessionTenantId } from '@/lib/auth-session';
import { GET } from './route';

const makeParams = (runId: string) => ({ params: Promise.resolve({ runId }) });

describe('GET /api/agent-ops/[runId]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('returns 404 when the run does not exist for this tenant', async () => {
        vi.mocked(agentOpsService.getRun).mockResolvedValue(null);
        vi.mocked(agentOpsService.getRunEvents).mockResolvedValue([]);
        const res = await GET({} as any, makeParams('run-missing'));
        expect(res.status).toBe(404);
    });

    it('returns the run and its events scoped by tenant', async () => {
        vi.mocked(agentOpsService.getRun).mockResolvedValue({ id: 'run-1', status: 'completed' } as any);
        vi.mocked(agentOpsService.getRunEvents).mockResolvedValue([{ id: 'e1' }] as any);

        const res = await GET({} as any, makeParams('run-1'));
        const body = await res.json();

        expect(agentOpsService.getRun).toHaveBeenCalledWith('tenant-1', 'run-1');
        expect(agentOpsService.getRunEvents).toHaveBeenCalledWith('run-1', 'tenant-1');
        expect(res.status).toBe(200);
        expect(body).toEqual({ run: { id: 'run-1', status: 'completed' }, events: [{ id: 'e1' }] });
    });

    it('returns 500 when a dependency throws', async () => {
        vi.mocked(agentOpsService.getRun).mockRejectedValue(new Error('DB down'));
        vi.mocked(agentOpsService.getRunEvents).mockResolvedValue([]);
        const res = await GET({} as any, makeParams('run-1'));
        expect(res.status).toBe(500);
    });
});
