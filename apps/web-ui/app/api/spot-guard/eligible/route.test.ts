import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/spot-guard-service', () => ({ SpotGuardService: { listEligibleServices: vi.fn() } }));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { SpotGuardService } from '@/lib/spot-guard-service';
import { GET } from './route';

const makeRequest = (url = 'http://localhost/api/spot-guard/eligible') => ({ url }) as any;

describe('GET /api/spot-guard/eligible', () => {
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

    it('returns eligible services with pagination meta', async () => {
        vi.mocked(SpotGuardService.listEligibleServices).mockResolvedValue({ services: [{ id: 's1' }], total: 1 } as any);

        const res = await GET(makeRequest('http://localhost/api/spot-guard/eligible?page=2&limit=10&eligibility=eligible'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data).toEqual([{ id: 's1' }]);
        expect(body.meta).toEqual({ total: 1, page: 2, limit: 10 });
        expect(SpotGuardService.listEligibleServices).toHaveBeenCalledWith(
            expect.objectContaining({ tenantId: 'tenant-1', page: 2, limit: 10, eligibility: 'eligible' })
        );
    });

    it('returns 500 when the service throws', async () => {
        vi.mocked(SpotGuardService.listEligibleServices).mockRejectedValue(new Error('DB down'));
        const res = await GET(makeRequest());
        expect(res.status).toBe(500);
    });
});
