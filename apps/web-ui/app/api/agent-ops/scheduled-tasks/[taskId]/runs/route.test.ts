import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/agent-ops/agent-ops-service', () => ({ agentOpsService: { listRuns: vi.fn() } }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));

import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
import { getSessionTenantId } from '@/lib/auth-session';
import { GET } from './route';

const makeParams = (taskId: string) => ({ params: Promise.resolve({ taskId }) });
const makeRequest = (search = '') => ({ url: `http://localhost/api/agent-ops/scheduled-tasks/t1/runs${search}` }) as any;

describe('GET /api/agent-ops/scheduled-tasks/[taskId]/runs', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('lists runs for the task, filtered server-side by source and taskId', async () => {
        vi.mocked(agentOpsService.listRuns).mockResolvedValue({ runs: [{ id: 'r1' }], total: 1 } as any);

        const res = await GET(makeRequest(), makeParams('t1'));
        const body = await res.json();

        expect(agentOpsService.listRuns).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: 'tenant-1', source: 'scheduled', taskId: 't1', page: 1, limit: 25,
        }));
        expect(res.status).toBe(200);
        expect(body).toEqual({ runs: [{ id: 'r1' }], total: 1, page: 1, limit: 25 });
    });

    it('clamps limit to 100 and falls back to page 1 for a non-positive page', async () => {
        vi.mocked(agentOpsService.listRuns).mockResolvedValue({ runs: [], total: 0 } as any);
        await GET(makeRequest('?page=-1&limit=500'), makeParams('t1'));
        expect(agentOpsService.listRuns).toHaveBeenCalledWith(expect.objectContaining({ page: 1, limit: 100 }));
    });

    it('falls back to defaults for a non-numeric limit', async () => {
        vi.mocked(agentOpsService.listRuns).mockResolvedValue({ runs: [], total: 0 } as any);
        await GET(makeRequest('?limit=abc'), makeParams('t1'));
        expect(agentOpsService.listRuns).toHaveBeenCalledWith(expect.objectContaining({ limit: 25 }));
    });

    it('returns 500 when the service throws', async () => {
        vi.mocked(agentOpsService.listRuns).mockRejectedValue(new Error('DB down'));
        const res = await GET(makeRequest(), makeParams('t1'));
        expect(res.status).toBe(500);
    });
});
