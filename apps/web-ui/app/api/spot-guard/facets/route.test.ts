import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/spot-guard-service', () => ({ SpotGuardService: { getFacets: vi.fn() } }));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { SpotGuardService } from '@/lib/spot-guard-service';
import { GET } from './route';

describe('GET /api/spot-guard/facets', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await GET({} as any);
        expect(res).toBe(authError);
    });

    it('returns 200 with facet data', async () => {
        vi.mocked(SpotGuardService.getFacets).mockResolvedValue({ regions: ['us-east-1'], clusters: ['c1'] } as any);

        const res = await GET({} as any);
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data).toEqual({ regions: ['us-east-1'], clusters: ['c1'] });
        expect(SpotGuardService.getFacets).toHaveBeenCalledWith('tenant-1');
    });

    it('returns 500 when the service throws', async () => {
        vi.mocked(SpotGuardService.getFacets).mockRejectedValue(new Error('DB down'));
        const res = await GET({} as any);
        expect(res.status).toBe(500);
    });
});
