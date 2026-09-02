import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn(), getSessionUserId: vi.fn() }));
vi.mock('@/lib/scaling-audit-service', () => ({
    ScalingAuditService: { listRuns: vi.fn(), triggerScan: vi.fn() },
}));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId, getSessionUserId } from '@/lib/auth-session';
import { ScalingAuditService } from '@/lib/scaling-audit-service';
import { GET, POST } from './route';

const makeRequest = (url = 'http://localhost/api/scaling-audit/runs') => ({ url }) as any;

describe('GET /api/scaling-audit/runs', () => {
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

    it('returns run history', async () => {
        vi.mocked(ScalingAuditService.listRuns).mockResolvedValue({ runs: [{ id: 'run-1' }], total: 2 } as any);

        const res = await GET(makeRequest());
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data).toEqual([{ id: 'run-1' }]);
    });

    it('returns 500 when the service throws', async () => {
        vi.mocked(ScalingAuditService.listRuns).mockRejectedValue(new Error('DB down'));
        const res = await GET(makeRequest());
        expect(res.status).toBe(500);
    });
});

describe('POST /api/scaling-audit/runs', () => {
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
        vi.mocked(ScalingAuditService.triggerScan).mockResolvedValue({ alreadyRunning: false } as any);
        const res = await POST();
        expect(res.status).toBe(202);
    });

    it('returns 200 when a scan is already running', async () => {
        vi.mocked(ScalingAuditService.triggerScan).mockResolvedValue({ alreadyRunning: true } as any);
        const res = await POST();
        expect(res.status).toBe(200);
    });

    it('returns 500 when the service throws', async () => {
        vi.mocked(ScalingAuditService.triggerScan).mockRejectedValue(new Error('DB down'));
        const res = await POST();
        expect(res.status).toBe(500);
    });
});
