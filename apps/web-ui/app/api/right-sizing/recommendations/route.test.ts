import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/rbac/row-filter', () => ({ getReadRowFilter: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/right-sizing-service', () => ({ RightSizingService: { listRecommendations: vi.fn() } }));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { RightSizingService } from '@/lib/right-sizing-service';
import { GET } from './route';

const makeRequest = (url = 'http://localhost/api/right-sizing/recommendations') => ({ url }) as any;

describe('GET /api/right-sizing/recommendations', () => {
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

    it('defaults sort to "savings" for an unrecognized sort param', async () => {
        vi.mocked(RightSizingService.listRecommendations).mockResolvedValue({ recommendations: [], total: 0 } as any);

        await GET(makeRequest('http://localhost/api/right-sizing/recommendations?sort=bogus'));

        expect(RightSizingService.listRecommendations).toHaveBeenCalledWith(
            expect.objectContaining({ sort: 'savings' })
        );
    });

    it('accepts confidence and resource as valid sort values', async () => {
        vi.mocked(RightSizingService.listRecommendations).mockResolvedValue({ recommendations: [], total: 0 } as any);

        await GET(makeRequest('http://localhost/api/right-sizing/recommendations?sort=confidence'));

        expect(RightSizingService.listRecommendations).toHaveBeenCalledWith(
            expect.objectContaining({ sort: 'confidence' })
        );
    });

    it('returns recommendations with pagination meta', async () => {
        vi.mocked(RightSizingService.listRecommendations).mockResolvedValue({
            recommendations: [{ id: 'r1' }], total: 30,
        } as any);

        const res = await GET(makeRequest('http://localhost/api/right-sizing/recommendations?page=2&limit=10'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.meta).toEqual({ total: 30, page: 2, limit: 10, totalPages: 3 });
    });

    it('returns 500 when the service throws', async () => {
        vi.mocked(RightSizingService.listRecommendations).mockRejectedValue(new Error('DB down'));
        const res = await GET(makeRequest());
        expect(res.status).toBe(500);
    });
});
