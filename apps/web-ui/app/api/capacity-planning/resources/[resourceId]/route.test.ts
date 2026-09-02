import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/capacity-planning-service', () => ({ CapacityPlanningService: { getResourceDetail: vi.fn() } }));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { CapacityPlanningService } from '@/lib/capacity-planning-service';
import { GET } from './route';

const makeRequest = (url = 'http://localhost/api/capacity-planning/resources/res-1') => ({ url }) as any;
const makeParams = (resourceId: string) => ({ params: Promise.resolve({ resourceId }) });

describe('GET /api/capacity-planning/resources/[resourceId]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await GET(makeRequest(), makeParams('res-1'));
        expect(res).toBe(authError);
    });

    it('returns 404 when no capacity data is found', async () => {
        vi.mocked(CapacityPlanningService.getResourceDetail).mockResolvedValue(null);

        const res = await GET(makeRequest(), makeParams('res-missing'));
        const body = await res.json();

        expect(res.status).toBe(404);
        expect(body.error).toContain('No capacity data');
    });

    it('returns 200 with resource detail', async () => {
        vi.mocked(CapacityPlanningService.getResourceDetail).mockResolvedValue({ resourceId: 'res-1' } as any);

        const res = await GET(makeRequest(), makeParams('res-1'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data).toEqual({ resourceId: 'res-1' });
        expect(CapacityPlanningService.getResourceDetail).toHaveBeenCalledWith(expect.any(Object), 'res-1');
    });

    it('returns 500 when the service throws', async () => {
        vi.mocked(CapacityPlanningService.getResourceDetail).mockRejectedValue(new Error('DB down'));
        const res = await GET(makeRequest(), makeParams('res-1'));
        expect(res.status).toBe(500);
    });
});
