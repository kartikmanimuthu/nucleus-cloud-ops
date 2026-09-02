import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/spot-guard-service', () => ({ SpotGuardService: { getHoursReport: vi.fn() } }));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { SpotGuardService } from '@/lib/spot-guard-service';
import { GET } from './route';

const makeRequest = (url = 'http://localhost/api/spot-guard/report') => ({ url }) as any;

describe('GET /api/spot-guard/report', () => {
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

    it('defaults to a 7-day window ending now', async () => {
        vi.mocked(SpotGuardService.getHoursReport).mockResolvedValue({ hours: [] } as any);

        const res = await GET(makeRequest());
        expect(res.status).toBe(200);
        expect(SpotGuardService.getHoursReport).toHaveBeenCalledWith('tenant-1', expect.objectContaining({
            from: expect.any(Date), to: expect.any(Date),
        }));
    });

    it('returns 400 for an unparseable date', async () => {
        const res = await GET(makeRequest('http://localhost/api/spot-guard/report?from=not-a-date'));
        expect(res.status).toBe(400);
    });

    it('returns 400 when from is not before to', async () => {
        const res = await GET(makeRequest('http://localhost/api/spot-guard/report?from=2024-06-10&to=2024-06-01'));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.error).toContain('before');
    });

    it('returns 400 when the range exceeds 92 days', async () => {
        const res = await GET(makeRequest('http://localhost/api/spot-guard/report?from=2024-01-01&to=2024-06-01'));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.error).toContain('Range too large');
    });

    it('accepts a valid explicit range', async () => {
        vi.mocked(SpotGuardService.getHoursReport).mockResolvedValue({ hours: [1, 2] } as any);

        const res = await GET(makeRequest('http://localhost/api/spot-guard/report?from=2024-06-01&to=2024-06-10'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data).toEqual({ hours: [1, 2] });
    });

    it('returns 500 when the service throws', async () => {
        vi.mocked(SpotGuardService.getHoursReport).mockRejectedValue(new Error('DB down'));
        const res = await GET(makeRequest('http://localhost/api/spot-guard/report?from=2024-06-01&to=2024-06-10'));
        expect(res.status).toBe(500);
    });
});
