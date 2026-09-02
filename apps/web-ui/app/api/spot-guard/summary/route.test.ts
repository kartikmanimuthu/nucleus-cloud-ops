import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/spot-guard-service', () => ({ SpotGuardService: { getSummary: vi.fn() } }));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { SpotGuardService } from '@/lib/spot-guard-service';
import { GET } from './route';

describe('GET /api/spot-guard/summary', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await GET();
        expect(res).toBe(authError);
    });

    it('returns 200 with summary KPIs', async () => {
        vi.mocked(SpotGuardService.getSummary).mockResolvedValue({ managed: 5, savings: 1000 } as any);

        const res = await GET();
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data).toEqual({ managed: 5, savings: 1000 });
        expect(SpotGuardService.getSummary).toHaveBeenCalledWith('tenant-1');
    });

    it('returns 500 when the service throws', async () => {
        vi.mocked(SpotGuardService.getSummary).mockRejectedValue(new Error('DB down'));
        const res = await GET();
        expect(res.status).toBe(500);
    });
});
