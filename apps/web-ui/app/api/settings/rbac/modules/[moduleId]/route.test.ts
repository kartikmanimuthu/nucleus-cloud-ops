import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn(), getAuthSession: vi.fn() }));
vi.mock('@/lib/rbac/registry-admin-writes', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/rbac/registry-admin-writes')>()),
    updateModule: vi.fn(),
    deleteModule: vi.fn(),
}));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { updateModule, deleteModule, SystemRowError, RegistryInUseError } from '@/lib/rbac/registry-admin-writes';
import { PUT, DELETE } from './route';

const VALID_BODY = { key: 'k', label: 'L', actionKeys: ['read'], subjectKeys: ['Account'] };
const makeParams = (moduleId: string) => ({ params: Promise.resolve({ moduleId }) });
const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;
const makeRequestNoBody = () => ({ json: vi.fn().mockRejectedValue(new Error('no body')) }) as any;

describe('PUT /api/settings/rbac/modules/[moduleId]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getAuthSession).mockResolvedValue({ user: { id: 'u1', email: 'a@b.co' } } as any);
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await PUT(makeRequest(VALID_BODY), makeParams('m1'));
        expect(res).toBe(authError);
        expect(updateModule).not.toHaveBeenCalled();
    });

    it('returns 400 when key or label is missing', async () => {
        const res = await PUT(makeRequest({ actionKeys: [], subjectKeys: [] }), makeParams('m1'));
        expect(res.status).toBe(400);
    });

    it('returns 400 when sortOrder is present but non-numeric', async () => {
        const res = await PUT(makeRequest({ ...VALID_BODY, sortOrder: 'abc' }), makeParams('m1'));
        expect(res.status).toBe(400);
    });

    it('updates the module with force/reason from the body', async () => {
        vi.mocked(updateModule).mockResolvedValue({ id: 'm1', materializedRules: 2, revokedRules: 0 } as any);

        const res = await PUT(makeRequest({ ...VALID_BODY, force: true, reason: 'cleanup' }), makeParams('m1'));
        const body = await res.json();

        expect(updateModule).toHaveBeenCalledWith(
            { userId: 'u1', email: 'a@b.co', tenantId: 'tenant-1' },
            'm1',
            expect.objectContaining({ key: 'k', label: 'L' }),
            { force: true, reason: 'cleanup' },
        );
        expect(res.status).toBe(200);
        expect(body.data.id).toBe('m1');
    });

    it('maps SystemRowError to 403', async () => {
        vi.mocked(updateModule).mockRejectedValue(new SystemRowError('system row'));
        const res = await PUT(makeRequest(VALID_BODY), makeParams('m1'));
        expect(res.status).toBe(403);
    });

    it('maps RegistryInUseError to 409', async () => {
        vi.mocked(updateModule).mockRejectedValue(new RegistryInUseError('in use'));
        const res = await PUT(makeRequest(VALID_BODY), makeParams('m1'));
        expect(res.status).toBe(409);
    });
});

describe('DELETE /api/settings/rbac/modules/[moduleId]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getAuthSession).mockResolvedValue({ user: { id: 'u1', email: 'a@b.co' } } as any);
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await DELETE(makeRequest({}), makeParams('m1'));
        expect(res).toBe(authError);
        expect(deleteModule).not.toHaveBeenCalled();
    });

    it('deletes the module, tolerating a missing request body', async () => {
        vi.mocked(deleteModule).mockResolvedValue(undefined as any);

        const res = await DELETE(makeRequestNoBody(), makeParams('m1'));
        const body = await res.json();

        expect(deleteModule).toHaveBeenCalledWith(
            { userId: 'u1', email: 'a@b.co', tenantId: 'tenant-1' }, 'm1', undefined,
        );
        expect(res.status).toBe(200);
        expect(body.data).toEqual({ id: 'm1' });
    });

    it('passes through a reason from the request body', async () => {
        vi.mocked(deleteModule).mockResolvedValue(undefined as any);
        await DELETE(makeRequest({ reason: 'obsolete' }), makeParams('m1'));
        expect(deleteModule).toHaveBeenCalledWith(expect.anything(), 'm1', 'obsolete');
    });

    it('maps SystemRowError to 403', async () => {
        vi.mocked(deleteModule).mockRejectedValue(new SystemRowError('system row'));
        const res = await DELETE(makeRequestNoBody(), makeParams('m1'));
        expect(res.status).toBe(403);
    });

    it('maps RegistryInUseError to 409', async () => {
        vi.mocked(deleteModule).mockRejectedValue(new RegistryInUseError('in use'));
        const res = await DELETE(makeRequestNoBody(), makeParams('m1'));
        expect(res.status).toBe(409);
    });
});
