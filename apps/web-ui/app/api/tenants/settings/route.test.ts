import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth-session', () => ({ getAuthSession: vi.fn(), getSessionTenantId: vi.fn() }));
vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/tenant-settings-service', () => ({
    TenantSettingsService: { getSettings: vi.fn(), updateSettings: vi.fn() },
}));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));

import { getAuthSession, getSessionTenantId } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';
import { TenantSettingsService } from '@/lib/tenant-settings-service';
import { AuditService } from '@/lib/audit-service';
import { GET, PUT } from './route';

const VALID_BODY = {
    name: 'Acme',
    timezone: 'America/New_York',
    notifications: { scheduleExecutions: true, memberInvites: false, systemAlerts: true },
};

const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;

describe('GET /api/tenants/settings', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('returns 200 with settings', async () => {
        vi.mocked(TenantSettingsService.getSettings).mockResolvedValue({ name: 'Acme' } as any);

        const res = await GET();
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body).toEqual({ success: true, data: { name: 'Acme' } });
    });

    it('returns 500 when the service throws', async () => {
        vi.mocked(TenantSettingsService.getSettings).mockRejectedValue(new Error('DB down'));

        const res = await GET();
        expect(res.status).toBe(500);
    });
});

describe('PUT /api/tenants/settings', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getAuthSession).mockResolvedValue({ user: { id: 'u1', email: 'a@b.co' } } as any);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await PUT(makeRequest(VALID_BODY));
        expect(res).toBe(authError);
    });

    it('returns 400 for an invalid body', async () => {
        const res = await PUT(makeRequest({ name: '' }));
        expect(res.status).toBe(400);
    });

    it('updates settings and logs a success audit event', async () => {
        vi.mocked(TenantSettingsService.updateSettings).mockResolvedValue(undefined as any);

        const res = await PUT(makeRequest(VALID_BODY));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body).toEqual({ success: true });
        expect(TenantSettingsService.updateSettings).toHaveBeenCalledWith('tenant-1', VALID_BODY, 'u1');
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'tenant.settings.updated', status: 'success' })
        );
    });

    it('returns 500 and logs a failure audit event when the service throws', async () => {
        vi.mocked(TenantSettingsService.updateSettings).mockRejectedValue(new Error('DB down'));

        const res = await PUT(makeRequest(VALID_BODY));
        expect(res.status).toBe(500);
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'error' })
        );
    });
});
