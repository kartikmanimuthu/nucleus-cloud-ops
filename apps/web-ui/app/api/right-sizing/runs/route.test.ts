import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn(), getSessionUserId: vi.fn() }));
vi.mock('@/lib/right-sizing-service', () => ({
    RightSizingService: { listRuns: vi.fn(), triggerScan: vi.fn() },
}));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId, getSessionUserId } from '@/lib/auth-session';
import { RightSizingService } from '@/lib/right-sizing-service';
import { GET, POST } from './route';

const makeRequest = (url = 'http://localhost/api/right-sizing/runs') => ({ url }) as any;

describe('GET /api/right-sizing/runs', () => {
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

    it('returns run history with pagination meta', async () => {
        vi.mocked(RightSizingService.listRuns).mockResolvedValue({ runs: [{ id: 'run-1' }], total: 5 } as any);

        const res = await GET(makeRequest('http://localhost/api/right-sizing/runs?page=1&limit=20'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data).toEqual([{ id: 'run-1' }]);
        expect(body.meta).toEqual({ total: 5, page: 1, limit: 20 });
        expect(RightSizingService.listRuns).toHaveBeenCalledWith('tenant-1', 1, 20);
    });

    it('returns 500 when the service throws', async () => {
        vi.mocked(RightSizingService.listRuns).mockRejectedValue(new Error('DB down'));
        const res = await GET(makeRequest());
        expect(res.status).toBe(500);
    });
});

describe('POST /api/right-sizing/runs', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getSessionUserId).mockResolvedValue('u1');
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await POST();
        expect(res).toBe(authError);
    });

    it('returns 202 when a new scan is triggered', async () => {
        vi.mocked(RightSizingService.triggerScan).mockResolvedValue({ run: { id: 'run-1' }, alreadyRunning: false } as any);

        const res = await POST();
        const body = await res.json();

        expect(res.status).toBe(202);
        expect(body.alreadyRunning).toBe(false);
        expect(RightSizingService.triggerScan).toHaveBeenCalledWith('tenant-1', 'u1');
    });

    it('returns 200 when a scan is already running', async () => {
        vi.mocked(RightSizingService.triggerScan).mockResolvedValue({ run: { id: 'run-1' }, alreadyRunning: true } as any);

        const res = await POST();
        expect(res.status).toBe(200);
    });

    it('returns 500 when the service throws', async () => {
        vi.mocked(RightSizingService.triggerScan).mockRejectedValue(new Error('DB down'));
        const res = await POST();
        expect(res.status).toBe(500);
    });
});
