import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth-session', () => ({ getAuthSession: vi.fn() }));
vi.mock('@/lib/db/pg-config', () => ({ getPrismaClient: vi.fn() }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));

import { getAuthSession } from '@/lib/auth-session';
import { getPrismaClient } from '@/lib/db/pg-config';
import { AuditService } from '@/lib/audit-service';
import { POST } from './route';

const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;

describe('POST /api/tenants/switch', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getAuthSession).mockResolvedValue({ user: { id: 'u1', email: 'a@b.co' } } as any);
    });

    it('returns 401 when unauthenticated', async () => {
        vi.mocked(getAuthSession).mockResolvedValue(null as any);
        const res = await POST(makeRequest({ tenantId: 't1' }));
        expect(res.status).toBe(401);
    });

    it('returns 400 when tenantId is missing', async () => {
        const res = await POST(makeRequest({}));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.error).toBe('tenantId is required');
    });

    it('returns 403 when the user does not belong to the target tenant', async () => {
        vi.mocked(getPrismaClient).mockReturnValue({
            userTenantRole: { findFirst: vi.fn().mockResolvedValue(null) },
        } as any);

        const res = await POST(makeRequest({ tenantId: 't-other' }));
        const body = await res.json();

        expect(res.status).toBe(403);
        expect(body.error).toBe('Forbidden');
    });

    it('switches the active tenant and logs the audit event on success', async () => {
        const update = vi.fn().mockResolvedValue({});
        vi.mocked(getPrismaClient).mockReturnValue({
            userTenantRole: { findFirst: vi.fn().mockResolvedValue({ id: 'utr-1' }) },
            authUser: { update },
        } as any);

        const res = await POST(makeRequest({ tenantId: 't1' }));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body).toEqual({ success: true });
        expect(update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { activeTenantId: 't1' } });
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'tenant.organization.switched', resourceId: 't1' })
        );
    });

    it('returns 500 when the database call throws', async () => {
        vi.mocked(getPrismaClient).mockReturnValue({
            userTenantRole: { findFirst: vi.fn().mockRejectedValue(new Error('DB down')) },
        } as any);

        const res = await POST(makeRequest({ tenantId: 't1' }));
        expect(res.status).toBe(500);
    });
});
