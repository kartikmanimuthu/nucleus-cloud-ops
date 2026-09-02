import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/scaling-audit-service', () => ({ ScalingAuditService: { getWatermarkGaps: vi.fn() } }));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { ScalingAuditService } from '@/lib/scaling-audit-service';
import { GET } from './route';

describe('GET /api/scaling-audit/coverage', () => {
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

    it('returns coverage gaps', async () => {
        vi.mocked(ScalingAuditService.getWatermarkGaps).mockResolvedValue([{ id: 'gap-1' }] as any);

        const res = await GET();
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data).toEqual([{ id: 'gap-1' }]);
    });

    it('returns 500 when the service throws', async () => {
        vi.mocked(ScalingAuditService.getWatermarkGaps).mockRejectedValue(new Error('DB down'));
        const res = await GET();
        expect(res.status).toBe(500);
    });
});
