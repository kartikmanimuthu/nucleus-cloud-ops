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
const VALID_BODY = { applicationId: 'app-1', publicKey: 'pubkey-123456', botToken: 'bot-token-123456' };

describe('GET /api/agent-ops/settings/discord', () => {
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
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({
            enabled: true, applicationId: 'app-1', publicKey: 'pubkey-123456', botToken: 'bot-token-123456',
        } as any);
        const res = await GET();
        const body = await res.json();
        expect(body.configured).toBe(true);
        expect(body.botToken).not.toBe('bot-token-123456');
        expect(body.botToken).toContain('****');
    });

    it('returns 500 when the config read throws', async () => {
        vi.mocked(TenantConfigService.getConfig).mockRejectedValue(new Error('DB down'));
        const res = await GET();
        expect(res.status).toBe(500);
    });

    it('masks a short public key with all-asterisks and an unset bot token as an empty string', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ enabled: true, applicationId: 'app-1', publicKey: 'short', botToken: undefined } as any);
        const res = await GET();
        const body = await res.json();
        expect(body.publicKey).toBe('********');
        expect(body.botToken).toBe('');
    });
});

describe('POST /api/agent-ops/settings/discord (create)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getAuthSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
    });

    it('returns 409 when Discord is already configured', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ applicationId: 'x' } as any);
        const res = await POST(makeRequest(VALID_BODY));
        expect(res.status).toBe(409);
    });

    it('returns 400 when required fields are missing', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null);
        const res = await POST(makeRequest({ applicationId: 'app-1' }));
        expect(res.status).toBe(400);
    });

    it('creates the config and logs an audit event', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null);
        const res = await POST(makeRequest(VALID_BODY));
        const body = await res.json();

        expect(TenantConfigService.saveConfig).toHaveBeenCalledWith(
            'agent-ops-discord', expect.objectContaining({ applicationId: 'app-1', enabled: true }), 'tenant-1',
        );
        expect(res.status).toBe(200);
        expect(body.success).toBe(true);
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'agent.settings.discord_created' })
        );
    });

    it('returns 500 when saving throws', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null);
        vi.mocked(TenantConfigService.saveConfig).mockRejectedValue(new Error('DB down'));
        const res = await POST(makeRequest(VALID_BODY));
        expect(res.status).toBe(500);
    });
});

describe('PUT /api/agent-ops/settings/discord (update)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getAuthSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
        vi.mocked(TenantConfigService.saveConfig).mockResolvedValue(undefined as any);
    });

    it('returns 404 when Discord is not configured yet', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null);
        const res = await PUT(makeRequest(VALID_BODY));
        expect(res.status).toBe(404);
    });

    it('merges blank fields with the existing config and updates', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({
            applicationId: 'app-1', publicKey: 'pubkey-123456', botToken: 'bot-token-123456', enabled: true,
        } as any);

        const res = await PUT(makeRequest({ enabled: false }));
        const body = await res.json();

        expect(TenantConfigService.saveConfig).toHaveBeenCalledWith(
            'agent-ops-discord', expect.objectContaining({ applicationId: 'app-1', enabled: false }), 'tenant-1',
        );
        expect(res.status).toBe(200);
        expect(body.enabled).toBe(false);
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'agent.settings.discord_updated' })
        );
    });
});

describe('DELETE /api/agent-ops/settings/discord', () => {
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
        expect(TenantConfigService.deleteConfig).not.toHaveBeenCalled();
    });

    it('resets the config and logs a high-severity audit event', async () => {
        const res = await DELETE();
        const body = await res.json();

        expect(TenantConfigService.deleteConfig).toHaveBeenCalledWith('agent-ops-discord', 'tenant-1');
        expect(res.status).toBe(200);
        expect(body).toEqual({ success: true, configured: false, enabled: false });
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'agent.settings.discord_reset', severity: 'high' })
        );
    });

    it('returns 500 when deletion throws', async () => {
        vi.mocked(TenantConfigService.deleteConfig).mockRejectedValue(new Error('DB down'));
        const res = await DELETE();
        expect(res.status).toBe(500);
    });
});
