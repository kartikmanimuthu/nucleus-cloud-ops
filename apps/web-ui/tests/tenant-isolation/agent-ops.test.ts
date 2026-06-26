import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock auth session — controls which tenant the test impersonates
vi.mock('@/lib/auth-session', () => ({
    getSessionTenantId: vi.fn(),
    getAuthSession: vi.fn(),
    getSessionUserId: vi.fn(),
}));

// Mock agentOpsService — route calls agentOpsService.listRuns({ tenantId, ... })
vi.mock('@/lib/agent-ops/agent-ops-service', () => ({
    agentOpsService: {
        listRuns: vi.fn(),
    },
}));

import { getSessionTenantId } from '@/lib/auth-session';
import { agentOpsService } from '@/lib/agent-ops/agent-ops-service';
import { GET } from '@/app/api/agent-ops/route';

describe('Agent Ops API — cross-tenant isolation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(agentOpsService.listRuns).mockResolvedValue({ runs: [], lastKey: undefined });
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-a');
    });

    it('GET passes tenant-a to agentOpsService.listRuns — tenant-b data never queried', async () => {
        const req = new Request('http://localhost:3000/api/agent-ops');
        await GET(req);

        expect(agentOpsService.listRuns).toHaveBeenCalledWith(
            expect.objectContaining({ tenantId: 'tenant-a' })
        );

        const calls = vi.mocked(agentOpsService.listRuns).mock.calls;
        for (const [arg] of calls) {
            if (arg && typeof arg === 'object' && 'tenantId' in arg) {
                expect(arg.tenantId).not.toBe('tenant-b');
            }
        }
    });

    it('switching session to tenant-b queries tenant-b only', async () => {
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-b');
        const req = new Request('http://localhost:3000/api/agent-ops');
        await GET(req);

        expect(agentOpsService.listRuns).toHaveBeenCalledWith(
            expect.objectContaining({ tenantId: 'tenant-b' })
        );
    });

    it('tenant-a session never triggers a tenant-b query', async () => {
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-a');
        const req = new Request('http://localhost:3000/api/agent-ops');
        await GET(req);

        const calls = vi.mocked(agentOpsService.listRuns).mock.calls;
        const tenantIds = calls.map(([arg]) => (arg as { tenantId?: string })?.tenantId);
        expect(tenantIds).not.toContain('tenant-b');
    });
});
