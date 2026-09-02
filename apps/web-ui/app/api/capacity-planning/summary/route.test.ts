import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/capacity-planning-service', () => ({ CapacityPlanningService: { getUtilizationSummary: vi.fn() } }));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { CapacityPlanningService } from '@/lib/capacity-planning-service';
import { GET } from './route';

const makeRequest = (url = 'http://localhost/api/capacity-planning/summary') => ({ url }) as any;

describe('GET /api/capacity-planning/summary', () => {
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

    it('returns resources with pagination meta', async () => {
        vi.mocked(CapacityPlanningService.getUtilizationSummary).mockResolvedValue({ resources: [{ id: 'r1' }], total: 5 } as any);

        const res = await GET(makeRequest('http://localhost/api/capacity-planning/summary?page=1&limit=25'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.meta).toEqual({ total: 5, page: 1, limit: 25, totalPages: 1 });
    });

    it('returns 500 when the service throws', async () => {
        vi.mocked(CapacityPlanningService.getUtilizationSummary).mockRejectedValue(new Error('DB down'));
        const res = await GET(makeRequest());
        expect(res.status).toBe(500);
    });
});
