import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn(), getAuthSession: vi.fn() }));
vi.mock('@/lib/invitation-service', () => ({ InvitationService: { revokeInvitation: vi.fn() } }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { InvitationService } from '@/lib/invitation-service';
import { AuditService } from '@/lib/audit-service';
import { POST } from './route';

const makeParams = (id: string) => ({ params: Promise.resolve({ id }) });

describe('POST /api/invitations/[id]/revoke', () => {
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

        const res = await POST({} as any, makeParams('inv-1'));
        expect(res).toBe(authError);
        expect(InvitationService.revokeInvitation).not.toHaveBeenCalled();
    });

    it('revokes the invitation and logs a success audit event', async () => {
        vi.mocked(InvitationService.revokeInvitation).mockResolvedValue({ id: 'inv-1', status: 'revoked' } as any);

        const res = await POST({} as any, makeParams('inv-1'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data.status).toBe('revoked');
        expect(InvitationService.revokeInvitation).toHaveBeenCalledWith('inv-1', 'tenant-1');
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'tenant.invitation.revoked', status: 'success' })
        );
    });

    it('returns 500 and logs a failure audit event when the service throws', async () => {
        vi.mocked(InvitationService.revokeInvitation).mockRejectedValue(new Error('not found'));

        const res = await POST({} as any, makeParams('inv-missing'));
        expect(res.status).toBe(500);
        expect(AuditService.logUserAction).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
    });
});
