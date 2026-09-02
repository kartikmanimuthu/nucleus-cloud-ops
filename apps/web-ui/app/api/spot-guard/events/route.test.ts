import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/spot-guard-service', () => ({ SpotGuardService: { listEvents: vi.fn() } }));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { SpotGuardService } from '@/lib/spot-guard-service';
import { GET } from './route';

const makeRequest = (url = 'http://localhost/api/spot-guard/events') => ({ url }) as any;

describe('GET /api/spot-guard/events', () => {
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

    it('returns events with pagination meta', async () => {
        vi.mocked(SpotGuardService.listEvents).mockResolvedValue({ events: [{ id: 'e1' }], total: 40 } as any);

        const res = await GET(makeRequest('http://localhost/api/spot-guard/events?page=1&limit=20'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data).toEqual([{ id: 'e1' }]);
        expect(body.meta).toEqual({ total: 40, page: 1, limit: 20, totalPages: 2 });
    });

    it('splits a comma-separated eventTypes param into an array', async () => {
        vi.mocked(SpotGuardService.listEvents).mockResolvedValue({ events: [], total: 0 } as any);

        await GET(makeRequest('http://localhost/api/spot-guard/events?eventTypes=interruption,rebalance'));

        expect(SpotGuardService.listEvents).toHaveBeenCalledWith(
            expect.objectContaining({ eventTypes: ['interruption', 'rebalance'] })
        );
    });

    it('returns 500 when the service throws', async () => {
        vi.mocked(SpotGuardService.listEvents).mockRejectedValue(new Error('DB down'));
        const res = await GET(makeRequest());
        expect(res.status).toBe(500);
    });
});
