import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn(), getSessionUserEmail: vi.fn() }));

const mockDeleteService = vi.fn();
vi.mock('@/lib/db/repository-factory', () => ({ getSpotGuardRepository: () => ({ deleteService: mockDeleteService }) }));

vi.mock('@/lib/spot-guard-service', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/spot-guard-service')>()),
    SpotGuardService: { getServiceDetail: vi.fn(), setManagementState: vi.fn() },
}));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId, getSessionUserEmail } from '@/lib/auth-session';
import { SpotGuardService, SpotGuardErrors } from '@/lib/spot-guard-service';
import { GET, PATCH, DELETE } from './route';

const makeParams = (id: string) => ({ params: Promise.resolve({ id }) });
const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;

describe('GET /api/spot-guard/services/[id]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await GET({} as any, makeParams('svc-1'));
        expect(res).toBe(authError);
    });

    it('returns 200 with service detail', async () => {
        vi.mocked(SpotGuardService.getServiceDetail).mockResolvedValue({ id: 'svc-1' } as any);

        const res = await GET({} as any, makeParams('svc-1'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data).toEqual({ id: 'svc-1' });
    });

    it('returns 404 for a cross-tenant / missing service', async () => {
        vi.mocked(SpotGuardService.getServiceDetail).mockRejectedValue(new Error(SpotGuardErrors.NOT_FOUND));

        const res = await GET({} as any, makeParams('svc-missing'));
        const body = await res.json();

        expect(res.status).toBe(404);
        expect(body.error).toBe('Service not found');
    });

    it('returns 500 for an unexpected error', async () => {
        vi.mocked(SpotGuardService.getServiceDetail).mockRejectedValue(new Error('DB down'));
        const res = await GET({} as any, makeParams('svc-1'));
        expect(res.status).toBe(500);
    });
});

describe('PATCH /api/spot-guard/services/[id]', () => {
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

        const res = await PATCH(makeRequest({ managementState: 'managed' }), makeParams('svc-1'));
        expect(res).toBe(authError);
    });

    it('returns 400 for an invalid managementState', async () => {
        const res = await PATCH(makeRequest({ managementState: 'bogus' }), makeParams('svc-1'));
        expect(res.status).toBe(400);
    });

    it('treats an unparsable request body as an empty object and returns 400', async () => {
        const req = { json: vi.fn().mockRejectedValue(new Error('invalid JSON')) } as any;
        const res = await PATCH(req, makeParams('svc-1'));
        expect(res.status).toBe(400);
    });

    it('returns 500 for an unexpected error', async () => {
        vi.mocked(SpotGuardService.setManagementState).mockRejectedValue(new Error('DB down'));
        const res = await PATCH(makeRequest({ managementState: 'managed' }), makeParams('svc-1'));
        expect(res.status).toBe(500);
    });

    it('updates the management state and returns the result', async () => {
        vi.mocked(SpotGuardService.setManagementState).mockResolvedValue({ id: 'svc-1', managementState: 'unmanaged' } as any);

        const res = await PATCH(makeRequest({ managementState: 'unmanaged' }), makeParams('svc-1'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data.managementState).toBe('unmanaged');
        expect(SpotGuardService.setManagementState).toHaveBeenCalledWith('tenant-1', 'svc-1', 'unmanaged', 'a@b.co');
    });

    it('returns 404 for a missing service', async () => {
        vi.mocked(SpotGuardService.setManagementState).mockRejectedValue(new Error(SpotGuardErrors.NOT_FOUND));
        const res = await PATCH(makeRequest({ managementState: 'managed' }), makeParams('svc-missing'));
        expect(res.status).toBe(404);
    });
});

describe('DELETE /api/spot-guard/services/[id]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await DELETE({} as any, makeParams('svc-1'));
        expect(res).toBe(authError);
    });

    it('deletes the registry row and returns its id', async () => {
        mockDeleteService.mockResolvedValue(undefined);

        const res = await DELETE({} as any, makeParams('svc-1'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data).toEqual({ id: 'svc-1' });
        expect(mockDeleteService).toHaveBeenCalledWith('svc-1', 'tenant-1');
    });

    it('returns 404 for a missing service', async () => {
        mockDeleteService.mockRejectedValue(new Error(SpotGuardErrors.NOT_FOUND));
        const res = await DELETE({} as any, makeParams('svc-missing'));
        expect(res.status).toBe(404);
    });

    it('returns 500 for an unexpected error', async () => {
        mockDeleteService.mockRejectedValue(new Error('DB down'));
        const res = await DELETE({} as any, makeParams('svc-1'));
        expect(res.status).toBe(500);
    });
});
