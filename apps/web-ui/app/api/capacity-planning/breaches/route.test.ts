import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/capacity-planning-service', () => ({ CapacityPlanningService: { listBreachInstances: vi.fn() } }));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { CapacityPlanningService } from '@/lib/capacity-planning-service';
import { GET } from './route';

const makeRequest = (url = 'http://localhost/api/capacity-planning/breaches') => ({ url }) as any;

describe('GET /api/capacity-planning/breaches', () => {
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

    it('returns breach instances with pagination meta', async () => {
        vi.mocked(CapacityPlanningService.listBreachInstances).mockResolvedValue({ breaches: [{ id: 'b1' }], total: 12 } as any);

        const res = await GET(makeRequest('http://localhost/api/capacity-planning/breaches?page=1&limit=100'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.meta).toEqual({ total: 12, page: 1, limit: 100, totalPages: 1 });
    });

    it('passes a parsed numeric threshold as the second argument', async () => {
        vi.mocked(CapacityPlanningService.listBreachInstances).mockResolvedValue({ breaches: [], total: 0 } as any);

        await GET(makeRequest('http://localhost/api/capacity-planning/breaches?threshold=80'));

        expect(CapacityPlanningService.listBreachInstances).toHaveBeenCalledWith(expect.any(Object), 80);
    });

    it('returns 500 when the service throws', async () => {
        vi.mocked(CapacityPlanningService.listBreachInstances).mockRejectedValue(new Error('DB down'));
        const res = await GET(makeRequest());
        expect(res.status).toBe(500);
    });
});
