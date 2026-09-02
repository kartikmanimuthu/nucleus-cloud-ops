import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn(), getAuthSession: vi.fn() }));
vi.mock('@/lib/invitation-service', () => ({
    InvitationService: { createInvitation: vi.fn(), listInvitations: vi.fn() },
}));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));

import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { InvitationService } from '@/lib/invitation-service';
import { AuditService } from '@/lib/audit-service';
import { POST, GET } from './route';

const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;

describe('POST /api/invitations', () => {
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

        const res = await POST(makeRequest({ email: 'x@y.com', role: 'Member' }));
        expect(res).toBe(authError);
        expect(InvitationService.createInvitation).not.toHaveBeenCalled();
    });

    it('returns 400 when email or role is missing', async () => {
        const res = await POST(makeRequest({ email: 'x@y.com' }));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.error).toBe('Email and role are required');
    });

    it('creates the invitation, logs a success audit event, and returns 201', async () => {
        vi.mocked(InvitationService.createInvitation).mockResolvedValue({ id: 'inv-1' } as any);

        const res = await POST(makeRequest({ email: 'x@y.com', role: 'Member' }));
        const body = await res.json();

        expect(res.status).toBe(201);
        expect(body).toEqual({ success: true, data: { id: 'inv-1' } });
        expect(InvitationService.createInvitation).toHaveBeenCalledWith('tenant-1', 'x@y.com', 'Member', 'u1');
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'tenant.invitation.created', status: 'success' })
        );
    });

    it('returns 409 when the service reports the invitation already exists', async () => {
        vi.mocked(InvitationService.createInvitation).mockRejectedValue(new Error('An invitation already exists'));

        const res = await POST(makeRequest({ email: 'x@y.com', role: 'Member' }));
        const body = await res.json();

        expect(res.status).toBe(409);
        expect(body.success).toBe(false);
    });

    it('returns 500 for a non-conflict service error', async () => {
        vi.mocked(InvitationService.createInvitation).mockRejectedValue(new Error('DB down'));

        const res = await POST(makeRequest({ email: 'x@y.com', role: 'Member' }));
        expect(res.status).toBe(500);
        expect(AuditService.logUserAction).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
    });
});

describe('GET /api/invitations', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await GET();
        expect(res).toBe(authError);
    });

    it('returns 200 with the invitation list', async () => {
        vi.mocked(InvitationService.listInvitations).mockResolvedValue([{ id: 'inv-1' }] as any);

        const res = await GET();
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.data).toEqual([{ id: 'inv-1' }]);
    });

    it('returns 500 when the service throws', async () => {
        vi.mocked(InvitationService.listInvitations).mockRejectedValue(new Error('DB down'));
        const res = await GET();
        expect(res.status).toBe(500);
    });
});
