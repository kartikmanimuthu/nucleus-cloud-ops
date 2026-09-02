import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({
    getSessionTenantId: vi.fn(),
    getSessionUserId: vi.fn(),
    getAuthSession: vi.fn(),
}));
vi.mock('@/lib/db/pg-config', () => ({ getTenantClient: vi.fn() }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId, getSessionUserId, getAuthSession } from '@/lib/auth-session';
import { getTenantClient } from '@/lib/db/pg-config';
import { AuditService } from '@/lib/audit-service';
import { PATCH } from './route';

const makeParams = (memberId: string) => ({ params: Promise.resolve({ memberId }) });
const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;

function makeTenantClient(findUniqueResult: unknown, txOverrides: Record<string, unknown> = {}) {
    const tx = {
        customRole: { findFirst: vi.fn().mockResolvedValue({ id: 'role-admin' }) },
        userTenantRole: { update: vi.fn().mockResolvedValue({ id: 'member-1', role: 'Admin' }) },
        tenant: { update: vi.fn().mockResolvedValue({}) },
        ...txOverrides,
    };
    return {
        userTenantRole: { findUnique: vi.fn().mockResolvedValue(findUniqueResult) },
        $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
        __tx: tx,
    };
}

describe('PATCH /api/settings/members/[memberId]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getSessionUserId).mockResolvedValue('u-caller');
        vi.mocked(getAuthSession).mockResolvedValue({ user: { email: 'caller@x.com' } } as any);
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await PATCH(makeRequest({ role: 'Admin' }), makeParams('member-1'));
        expect(res).toBe(authError);
    });

    it('returns 400 when role is missing', async () => {
        const res = await PATCH(makeRequest({}), makeParams('member-1'));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.error).toBe('role is required');
    });

    it('returns 404 when the member does not exist', async () => {
        vi.mocked(getTenantClient).mockReturnValue(makeTenantClient(null) as any);

        const res = await PATCH(makeRequest({ role: 'Admin' }), makeParams('member-missing'));
        expect(res.status).toBe(404);
    });

    it('returns 403 when the caller tries to change their own role', async () => {
        vi.mocked(getTenantClient).mockReturnValue(
            makeTenantClient({ id: 'member-1', userId: 'u-caller', role: 'Member' }) as any
        );

        const res = await PATCH(makeRequest({ role: 'Admin' }), makeParams('member-1'));
        const body = await res.json();

        expect(res.status).toBe(403);
        expect(body.error).toBe('Cannot change your own role');
    });

    it('updates role + roleId together and bumps rbacVersion, then logs success', async () => {
        const client = makeTenantClient({ id: 'member-1', userId: 'u-other', role: 'Member' });
        vi.mocked(getTenantClient).mockReturnValue(client as any);

        const res = await PATCH(makeRequest({ role: 'Admin' }), makeParams('member-1'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.success).toBe(true);
        expect(client.__tx.userTenantRole.update).toHaveBeenCalledWith({
            where: { id: 'member-1' },
            data: { role: 'Admin', roleId: 'role-admin' },
        });
        expect(client.__tx.tenant.update).toHaveBeenCalledWith({
            where: { id: 'tenant-1' },
            data: { rbacVersion: { increment: 1 } },
        });
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'tenant.member.role_changed', status: 'success' })
        );
    });

    it('sets roleId to null when the target role has no tenant-local custom role row (predefined role)', async () => {
        const client = makeTenantClient(
            { id: 'member-1', userId: 'u-other', role: 'Member' },
            { customRole: { findFirst: vi.fn().mockResolvedValue(null) } }
        );
        vi.mocked(getTenantClient).mockReturnValue(client as any);

        await PATCH(makeRequest({ role: 'Owner' }), makeParams('member-1'));

        expect(client.__tx.userTenantRole.update).toHaveBeenCalledWith({
            where: { id: 'member-1' },
            data: { role: 'Owner', roleId: null },
        });
    });

    it('returns 500 and logs a failure audit event on unexpected error', async () => {
        vi.mocked(getTenantClient).mockReturnValue({
            userTenantRole: { findUnique: vi.fn().mockRejectedValue(new Error('DB down')) },
        } as any);

        const res = await PATCH(makeRequest({ role: 'Admin' }), makeParams('member-1'));
        expect(res.status).toBe(500);
        expect(AuditService.logUserAction).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
    });
});
