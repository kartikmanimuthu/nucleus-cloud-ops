import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/tenant-config-service', () => ({ TenantConfigService: { getConfig: vi.fn(), saveConfig: vi.fn(), deleteConfig: vi.fn() } }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn(), getAuthSession: vi.fn() }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));

import { TenantConfigService } from '@/lib/tenant-config-service';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import { authorize } from '@/lib/rbac/authorize';
import { GET, POST, PUT, DELETE } from './route';

const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;
const VALID_BODY = { webhookSecret: 'secret-123456' };

describe('GET /api/agent-ops/settings/jira', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
    });

    it('reports unconfigured when no config is saved', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null);
        const res = await GET();
        const body = await res.json();
        expect(body).toEqual({ configured: false, enabled: false });
    });

    it('returns masked secrets and plain fields when configured', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({
            enabled: true, webhookSecret: 'secret-123456', baseUrl: 'https://x.atlassian.net',
            userEmail: 'a@b.co', apiToken: 'tok-123456', botAccountId: 'acc-1', autoApprove: true,
        } as any);
        const res = await GET();
        const body = await res.json();
        expect(body.configured).toBe(true);
        expect(body.webhookSecret).toContain('****');
        expect(body.baseUrl).toBe('https://x.atlassian.net');
        expect(body.autoApprove).toBe(true);
    });

    it('returns 500 when the config read throws', async () => {
        vi.mocked(TenantConfigService.getConfig).mockRejectedValue(new Error('DB down'));
        const res = await GET();
        expect(res.status).toBe(500);
    });
});

describe('POST /api/agent-ops/settings/jira (create)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getAuthSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null);
    });

    it('returns 409 when Jira is already configured', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ webhookSecret: 'x' } as any);
        const res = await POST(makeRequest(VALID_BODY));
        expect(res.status).toBe(409);
    });

    it('returns 400 when webhookSecret is missing', async () => {
        const res = await POST(makeRequest({}));
        expect(res.status).toBe(400);
    });

    it('creates the config and logs an audit event', async () => {
        const res = await POST(makeRequest(VALID_BODY));
        const body = await res.json();

        expect(TenantConfigService.saveConfig).toHaveBeenCalledWith(
            'agent-ops-jira', expect.objectContaining({ webhookSecret: 'secret-123456', enabled: true, autoApprove: false }), 'tenant-1',
        );
        expect(res.status).toBe(200);
        expect(body.success).toBe(true);
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'agent.settings.jira_created' })
        );
    });

    it('returns 500 when saving throws', async () => {
        vi.mocked(TenantConfigService.saveConfig).mockRejectedValue(new Error('DB down'));
        const res = await POST(makeRequest(VALID_BODY));
        expect(res.status).toBe(500);
    });
});

describe('PUT /api/agent-ops/settings/jira (update)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getAuthSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
        vi.mocked(TenantConfigService.saveConfig).mockResolvedValue(undefined as any);
    });

    it('returns 404 when Jira is not configured yet', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null);
        const res = await PUT(makeRequest(VALID_BODY));
        expect(res.status).toBe(404);
    });

    it('merges blank fields with the existing config', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ webhookSecret: 'secret-123456', enabled: true, autoApprove: false } as any);

        const res = await PUT(makeRequest({ autoApprove: true }));
        const body = await res.json();

        expect(TenantConfigService.saveConfig).toHaveBeenCalledWith(
            'agent-ops-jira', expect.objectContaining({ webhookSecret: 'secret-123456', autoApprove: true }), 'tenant-1',
        );
        expect(body.autoApprove).toBe(true);
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'agent.settings.jira_updated' })
        );
    });
});

describe('DELETE /api/agent-ops/settings/jira', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getAuthSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await DELETE();
        expect(res).toBe(authError);
    });

    it('resets the config and logs a high-severity audit event', async () => {
        const res = await DELETE();
        const body = await res.json();
        expect(TenantConfigService.deleteConfig).toHaveBeenCalledWith('agent-ops-jira', 'tenant-1');
        expect(body).toEqual({ success: true, configured: false, enabled: false });
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'agent.settings.jira_reset', severity: 'high' })
        );
    });

    it('returns 500 when deletion throws', async () => {
        vi.mocked(TenantConfigService.deleteConfig).mockRejectedValue(new Error('DB down'));
        const res = await DELETE();
        expect(res.status).toBe(500);
    });
});
