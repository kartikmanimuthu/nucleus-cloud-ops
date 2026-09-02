import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/rbac/row-filter', () => ({ getReadRowFilter: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/spot-guard-service', () => ({ SpotGuardService: { listServices: vi.fn() } }));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { SpotGuardService } from '@/lib/spot-guard-service';
import { GET } from './route';

const makeRequest = (url = 'http://localhost/api/spot-guard/services') => ({ url }) as any;

describe('GET /api/spot-guard/services', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await GET(makeRequest());
        expect(res).toBe(authError);
    });

    it('returns paginated services with meta', async () => {
        vi.mocked(SpotGuardService.listServices).mockResolvedValue({ services: [{ id: 's1' }], total: 30 } as any);

        const res = await GET(makeRequest('http://localhost/api/spot-guard/services?page=2&limit=10'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data).toEqual([{ id: 's1' }]);
        expect(body.meta).toEqual({ total: 30, page: 2, limit: 10, totalPages: 3 });
        expect(SpotGuardService.listServices).toHaveBeenCalledWith(
            expect.objectContaining({ tenantId: 'tenant-1', page: 2, limit: 10, rowFilter: null })
        );
    });

    it('passes through filter query params', async () => {
        vi.mocked(SpotGuardService.listServices).mockResolvedValue({ services: [], total: 0 } as any);

        await GET(makeRequest('http://localhost/api/spot-guard/services?account=acc-1&region=us-east-1&cluster=c1&capacityState=at_risk&managementState=managed&search=web'));

        expect(SpotGuardService.listServices).toHaveBeenCalledWith(
            expect.objectContaining({
                accountId: 'acc-1', region: 'us-east-1', clusterName: 'c1',
                capacityState: 'at_risk', managementState: 'managed', searchTerm: 'web',
            })
        );
    });

    it('returns 500 when the service throws', async () => {
        vi.mocked(SpotGuardService.listServices).mockRejectedValue(new Error('DB down'));
        const res = await GET(makeRequest());
        expect(res.status).toBe(500);
    });
});
