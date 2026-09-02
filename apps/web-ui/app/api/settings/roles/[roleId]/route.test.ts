import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn(), getAuthSession: vi.fn() }));
vi.mock('@/lib/rbac/custom-role-service', () => ({
    getCustomRole: vi.fn(), updateCustomRole: vi.fn(), deleteCustomRole: vi.fn(),
}));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { getCustomRole, updateCustomRole, deleteCustomRole } from '@/lib/rbac/custom-role-service';
import { AuditService } from '@/lib/audit-service';
import { GET, PUT, DELETE } from './route';

const VALID_BODY = { name: 'Editor', permissions: { Account: ['read'] } };
const makeParams = (roleId: string) => ({ params: Promise.resolve({ roleId }) });
const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;

describe('GET /api/settings/roles/[roleId]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await GET({} as any, makeParams('r1'));
        expect(res).toBe(authError);
        expect(getCustomRole).not.toHaveBeenCalled();
    });

    it('returns 404 when the role does not exist for this tenant', async () => {
        vi.mocked(getCustomRole).mockResolvedValue(null);
        const res = await GET({} as any, makeParams('r-missing'));
        expect(res.status).toBe(404);
    });

    it('fetches the role scoped by tenant', async () => {
        vi.mocked(getCustomRole).mockResolvedValue({ id: 'r1', name: 'Editor' } as any);
        const res = await GET({} as any, makeParams('r1'));
        const body = await res.json();

        expect(getCustomRole).toHaveBeenCalledWith('tenant-1', 'r1');
        expect(res.status).toBe(200);
        expect(body.data).toEqual({ id: 'r1', name: 'Editor' });
    });

    it('returns 500 when the service throws', async () => {
        vi.mocked(getCustomRole).mockRejectedValue(new Error('DB down'));
        const res = await GET({} as any, makeParams('r1'));
        expect(res.status).toBe(500);
    });
});

describe('PUT /api/settings/roles/[roleId]', () => {
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

        const res = await PUT(makeRequest(VALID_BODY), makeParams('r1'));
        expect(res).toBe(authError);
        expect(updateCustomRole).not.toHaveBeenCalled();
    });

    it('returns 400 when name is blank', async () => {
        const res = await PUT(makeRequest({ ...VALID_BODY, name: '' }), makeParams('r1'));
        expect(res.status).toBe(400);
    });

    it('returns 400 when name exceeds 50 characters', async () => {
        const res = await PUT(makeRequest({ ...VALID_BODY, name: 'x'.repeat(51) }), makeParams('r1'));
        expect(res.status).toBe(400);
    });

    it('updates the role scoped by tenant and logs a high-severity audit event', async () => {
        vi.mocked(updateCustomRole).mockResolvedValue({ id: 'r1', name: 'Editor' } as any);

        const res = await PUT(makeRequest(VALID_BODY), makeParams('r1'));
        const body = await res.json();

        expect(updateCustomRole).toHaveBeenCalledWith(
            'tenant-1', 'r1', { name: 'Editor', permissions: { Account: ['read'] }, overrides: {} },
            { userId: 'u1', email: 'a@b.co' },
        );
        expect(res.status).toBe(200);
        expect(body.data).toEqual({ id: 'r1', name: 'Editor' });
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'rbac.role.updated', severity: 'high', status: 'success' })
        );
    });

    it('returns 500 and logs a failure audit event on error', async () => {
        vi.mocked(updateCustomRole).mockRejectedValue(new Error('DB down'));
        const res = await PUT(makeRequest(VALID_BODY), makeParams('r1'));
        expect(res.status).toBe(500);
        expect(AuditService.logUserAction).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
    });
});

describe('DELETE /api/settings/roles/[roleId]', () => {
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

        const res = await DELETE({} as any, makeParams('r1'));
        expect(res).toBe(authError);
        expect(deleteCustomRole).not.toHaveBeenCalled();
    });

    it('deletes the role scoped by tenant and logs a high-severity audit event', async () => {
        vi.mocked(deleteCustomRole).mockResolvedValue(undefined as any);

        const res = await DELETE({} as any, makeParams('r1'));
        const body = await res.json();

        expect(deleteCustomRole).toHaveBeenCalledWith('tenant-1', 'r1', { userId: 'u1', email: 'a@b.co' });
        expect(res.status).toBe(200);
        expect(body).toEqual({ success: true });
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'rbac.role.deleted', severity: 'high', status: 'success' })
        );
    });

    it('returns 500 and logs a failure audit event on error', async () => {
        vi.mocked(deleteCustomRole).mockRejectedValue(new Error('DB down'));
        const res = await DELETE({} as any, makeParams('r1'));
        expect(res.status).toBe(500);
        expect(AuditService.logUserAction).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
    });
});
