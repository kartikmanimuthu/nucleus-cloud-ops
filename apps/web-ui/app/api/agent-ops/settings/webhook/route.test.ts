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

describe('GET /api/agent-ops/settings/webhook', () => {
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

    it('returns masked secrets when configured', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ enabled: true, webhookSecret: 'secret-123456' } as any);
        const res = await GET();
        const body = await res.json();
        expect(body.configured).toBe(true);
        expect(body.webhookSecret).toContain('****');
    });

    it('returns 500 when the config read throws', async () => {
        vi.mocked(TenantConfigService.getConfig).mockRejectedValue(new Error('DB down'));
        const res = await GET();
        expect(res.status).toBe(500);
    });

    it('masks a short secret with all-asterisks', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ enabled: true, webhookSecret: 'short' } as any);
        const res = await GET();
        const body = await res.json();
        expect(body.webhookSecret).toBe('********');
    });

    it('renders a missing stored secret as an empty string', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ enabled: true, webhookSecret: undefined } as any);
        const res = await GET();
        const body = await res.json();
        expect(body.webhookSecret).toBe('');
    });
});

describe('POST/PUT /api/agent-ops/settings/webhook (save)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getAuthSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
    });

    it('returns 409 on POST when already configured', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ webhookSecret: 'x' } as any);
        const res = await POST(makeRequest(VALID_BODY));
        expect(res.status).toBe(409);
    });

    it('returns 404 on PUT when not configured yet', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null);
        const res = await PUT(makeRequest(VALID_BODY));
        expect(res.status).toBe(404);
    });

    it('returns 400 when webhookSecret is missing', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null);
        const res = await POST(makeRequest({}));
        expect(res.status).toBe(400);
    });

    it('creates the config and logs an audit event', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null);
        const res = await POST(makeRequest(VALID_BODY));
        const body = await res.json();

        expect(TenantConfigService.saveConfig).toHaveBeenCalledWith(
            'agent-ops-webhook', expect.objectContaining({ webhookSecret: 'secret-123456', enabled: true }), 'tenant-1',
        );
        expect(res.status).toBe(200);
        expect(body.success).toBe(true);
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'agent.settings.webhook_created' })
        );
    });

    it('returns 500 when saving throws', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null);
        vi.mocked(TenantConfigService.saveConfig).mockRejectedValue(new Error('DB down'));
        const res = await POST(makeRequest(VALID_BODY));
        expect(res.status).toBe(500);
    });
});

describe('DELETE /api/agent-ops/settings/webhook', () => {
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
        expect(TenantConfigService.deleteConfig).toHaveBeenCalledWith('agent-ops-webhook', 'tenant-1');
        expect(body).toEqual({ success: true, configured: false, enabled: false });
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'agent.settings.webhook_reset', severity: 'high' })
        );
    });

    it('returns 500 when deletion throws', async () => {
        vi.mocked(TenantConfigService.deleteConfig).mockRejectedValue(new Error('DB down'));
        const res = await DELETE();
        expect(res.status).toBe(500);
    });
});
