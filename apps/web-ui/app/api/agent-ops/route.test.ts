import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/agent-ops/agent-ops-service', () => ({ agentOpsService: { listRuns: vi.fn() } }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/rbac/row-filter', () => ({ getReadRowFilter: vi.fn().mockResolvedValue(undefined) }));

import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
import { getSessionTenantId } from '@/lib/auth-session';
import { getReadRowFilter } from '@/lib/rbac/row-filter';
import { GET } from './route';

const makeRequest = (search = '') => ({ url: `http://localhost/api/agent-ops${search}` }) as any;

describe('GET /api/agent-ops', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('lists runs with defaults, scoped by tenant and row filter', async () => {
        vi.mocked(getReadRowFilter).mockResolvedValue({ x: 1 } as any);
        vi.mocked(agentOpsService.listRuns).mockResolvedValue({ runs: [{ id: 'r1' }], total: 1, stats: {} } as any);

        const res = await GET(makeRequest());
        const body = await res.json();

        expect(agentOpsService.listRuns).toHaveBeenCalledWith(expect.objectContaining({
            tenantId: 'tenant-1', page: 1, limit: 25, sortBy: 'createdAt', sortDir: 'desc', rowFilter: { x: 1 },
        }));
        expect(res.status).toBe(200);
        expect(body).toEqual({ success: true, data: [{ id: 'r1' }], total: 1, stats: {} });
    });

    it('clamps limit to 100 and falls back to an invalid sortBy → createdAt', async () => {
        vi.mocked(agentOpsService.listRuns).mockResolvedValue({ runs: [], total: 0, stats: {} } as any);
        await GET(makeRequest('?limit=999&page=0&sortBy=bogus&sortDir=asc'));
        expect(agentOpsService.listRuns).toHaveBeenCalledWith(expect.objectContaining({
            limit: 100, page: 1, sortBy: 'createdAt', sortDir: 'asc',
        }));
    });

    it('accepts a valid sortBy field', async () => {
        vi.mocked(agentOpsService.listRuns).mockResolvedValue({ runs: [], total: 0, stats: {} } as any);
        await GET(makeRequest('?sortBy=durationMs'));
        expect(agentOpsService.listRuns).toHaveBeenCalledWith(expect.objectContaining({ sortBy: 'durationMs' }));
    });

    it('returns 500 when the service throws', async () => {
        vi.mocked(agentOpsService.listRuns).mockRejectedValue(new Error('DB down'));
        const res = await GET(makeRequest());
        expect(res.status).toBe(500);
    });
});
