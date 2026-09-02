import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/network-links-service', () => ({ NetworkLinksService: { listSamples: vi.fn() } }));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { NetworkLinksService } from '@/lib/network-links-service';
import { GET } from './route';

const makeRequest = (url: string) => ({ url }) as any;

describe('GET /api/network-links/report', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await GET(makeRequest('http://localhost/api/network-links/report?dateFrom=2024-06-01&dateTo=2024-06-02'));
        expect(res).toBe(authError);
    });

    it('returns 400 when dateFrom or dateTo is missing', async () => {
        const res = await GET(makeRequest('http://localhost/api/network-links/report?dateFrom=2024-06-01'));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.error).toContain('dateFrom and dateTo');
    });

    it('returns 200 with the built report rows', async () => {
        vi.mocked(NetworkLinksService.listSamples).mockResolvedValue([]);

        const res = await GET(makeRequest('http://localhost/api/network-links/report?dateFrom=2024-06-01&dateTo=2024-06-02'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.success).toBe(true);
        expect(Array.isArray(body.data)).toBe(true);
        expect(NetworkLinksService.listSamples).toHaveBeenCalledWith('tenant-1', expect.objectContaining({
            dateFrom: '2024-06-01', dateTo: '2024-06-02',
        }));
    });

    it('returns 500 when the service throws', async () => {
        vi.mocked(NetworkLinksService.listSamples).mockRejectedValue(new Error('DB down'));

        const res = await GET(makeRequest('http://localhost/api/network-links/report?dateFrom=2024-06-01&dateTo=2024-06-02'));
        expect(res.status).toBe(500);
    });
});
