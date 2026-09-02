import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn(), getSessionUserEmail: vi.fn() }));
vi.mock('@/lib/spot-guard-service', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/spot-guard-service')>()),
    SpotGuardService: { disableSpot: vi.fn() },
}));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId, getSessionUserEmail } from '@/lib/auth-session';
import { SpotGuardService, SpotGuardErrors } from '@/lib/spot-guard-service';
import { POST } from './route';

const makeParams = (id: string) => ({ params: Promise.resolve({ id }) });
const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;
const VALID_BODY = { confirm: true, confirmServiceName: 'web-svc' };

describe('POST /api/spot-guard/services/[id]/disable', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getSessionUserEmail).mockResolvedValue('a@b.co');
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await POST(makeRequest(VALID_BODY), makeParams('svc-1'));
        expect(res).toBe(authError);
    });

    it('returns 400 when confirm is not true', async () => {
        const res = await POST(makeRequest({ confirm: false, confirmServiceName: 'web-svc' }), makeParams('svc-1'));
        expect(res.status).toBe(400);
    });

    it('disables Spot and returns 202', async () => {
        vi.mocked(SpotGuardService.disableSpot).mockResolvedValue({ id: 'svc-1', strategy: 'on_demand' } as any);

        const res = await POST(makeRequest(VALID_BODY), makeParams('svc-1'));
        const body = await res.json();

        expect(res.status).toBe(202);
        expect(body.data.strategy).toBe('on_demand');
        expect(SpotGuardService.disableSpot).toHaveBeenCalledWith('tenant-1', 'svc-1', 'a@b.co', VALID_BODY);
    });

    it.each([
        [SpotGuardErrors.NOT_FOUND, 404],
        [SpotGuardErrors.CONFIRMATION_MISMATCH, 400],
        [SpotGuardErrors.SERVICE_NOT_IN_AWS, 409],
        [SpotGuardErrors.DEPLOYMENT_IN_PROGRESS, 409],
        [SpotGuardErrors.ACCOUNT_NOT_FOUND, 409],
    ])('maps %s to status %i', async (errorCode, status) => {
        vi.mocked(SpotGuardService.disableSpot).mockRejectedValue(new Error(errorCode));

        const res = await POST(makeRequest(VALID_BODY), makeParams('svc-1'));
        expect(res.status).toBe(status);
    });

    it('returns 500 for an unrecognized error', async () => {
        vi.mocked(SpotGuardService.disableSpot).mockRejectedValue(new Error('boom'));
        const res = await POST(makeRequest(VALID_BODY), makeParams('svc-1'));
        expect(res.status).toBe(500);
    });
});
