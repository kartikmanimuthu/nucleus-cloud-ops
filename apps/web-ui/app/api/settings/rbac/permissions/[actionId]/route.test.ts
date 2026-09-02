import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn(), getAuthSession: vi.fn() }));
vi.mock('@/lib/rbac/registry-admin-writes', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/rbac/registry-admin-writes')>()),
    updateAction: vi.fn(),
    deleteAction: vi.fn(),
}));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { updateAction, deleteAction, SystemRowError } from '@/lib/rbac/registry-admin-writes';
import { PUT, DELETE } from './route';

const makeParams = (actionId: string) => ({ params: Promise.resolve({ actionId }) });
const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;
const makeRequestNoBody = () => ({ json: vi.fn().mockRejectedValue(new Error('no body')) }) as any;

describe('PUT /api/settings/rbac/permissions/[actionId]', () => {
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

        const res = await PUT(makeRequest({ label: 'New' }), makeParams('a1'));
        expect(res).toBe(authError);
        expect(updateAction).not.toHaveBeenCalled();
    });

    it('returns 400 when sortOrder is present but non-numeric', async () => {
        const res = await PUT(makeRequest({ sortOrder: 'abc' }), makeParams('a1'));
        expect(res.status).toBe(400);
    });

    it('only patches fields present in the body', async () => {
        vi.mocked(updateAction).mockResolvedValue(undefined as any);

        const res = await PUT(makeRequest({ label: 'New Label' }), makeParams('a1'));
        const body = await res.json();

        expect(updateAction).toHaveBeenCalledWith(
            { userId: 'u1', email: 'a@b.co', tenantId: 'tenant-1' },
            'a1',
            { label: 'New Label' },
            undefined,
        );
        expect(res.status).toBe(200);
        expect(body.data).toEqual({ id: 'a1' });
    });

    it('maps SystemRowError to 403', async () => {
        vi.mocked(updateAction).mockRejectedValue(new SystemRowError('system row'));
        const res = await PUT(makeRequest({ label: 'x' }), makeParams('a1'));
        expect(res.status).toBe(403);
    });
});

describe('DELETE /api/settings/rbac/permissions/[actionId]', () => {
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

        const res = await DELETE(makeRequestNoBody(), makeParams('a1'));
        expect(res).toBe(authError);
        expect(deleteAction).not.toHaveBeenCalled();
    });

    it('deletes the permission, tolerating a missing request body', async () => {
        vi.mocked(deleteAction).mockResolvedValue(undefined as any);

        const res = await DELETE(makeRequestNoBody(), makeParams('a1'));
        const body = await res.json();

        expect(deleteAction).toHaveBeenCalledWith(
            { userId: 'u1', email: 'a@b.co', tenantId: 'tenant-1' }, 'a1', undefined,
        );
        expect(res.status).toBe(200);
        expect(body.data).toEqual({ id: 'a1' });
    });

    it('maps SystemRowError to 403', async () => {
        vi.mocked(deleteAction).mockRejectedValue(new SystemRowError('system row'));
        const res = await DELETE(makeRequestNoBody(), makeParams('a1'));
        expect(res.status).toBe(403);
    });
});
