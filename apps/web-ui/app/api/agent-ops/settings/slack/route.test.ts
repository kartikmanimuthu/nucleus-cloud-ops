import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/tenant-config-service', () => ({ TenantConfigService: { getConfig: vi.fn(), saveConfig: vi.fn(), deleteConfig: vi.fn() } }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn(), getAuthSession: vi.fn() }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/db/repository-factory', () => ({ getSlackWorkspaceLinkRepository: vi.fn() }));

import { TenantConfigService } from '@/lib/tenant-config-service';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import { authorize } from '@/lib/rbac/authorize';
import { getSlackWorkspaceLinkRepository } from '@/lib/db/repository-factory';
import { SlackWorkspaceLinkConflictError } from '@/lib/db/repositories/slack-workspace-link/interface';
import { GET, POST, PUT, DELETE } from './route';

const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;
const linkRepo = {
    getLinkForTenant: vi.fn(), upsertLink: vi.fn(), deleteLinkForTenant: vi.fn(),
};

describe('GET /api/agent-ops/settings/slack', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getSlackWorkspaceLinkRepository).mockReturnValue(linkRepo as any);
    });

    it('reports unconfigured when no config is saved', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null);
        const res = await GET();
        const body = await res.json();
        expect(body).toEqual({ configured: false, enabled: false });
    });

    it('returns masked secrets and the linked teamId when configured', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ enabled: true, signingSecret: 'sign-123456', botToken: 'xoxb-123456' } as any);
        linkRepo.getLinkForTenant.mockResolvedValue({ teamId: 'T123' });

        const res = await GET();
        const body = await res.json();
        expect(body.configured).toBe(true);
        expect(body.teamId).toBe('T123');
        expect(body.botToken).toContain('****');
    });

    it('returns 500 when the config read throws', async () => {
        vi.mocked(TenantConfigService.getConfig).mockRejectedValue(new Error('DB down'));
        const res = await GET();
        expect(res.status).toBe(500);
    });
});

describe('POST/PUT /api/agent-ops/settings/slack (save)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getAuthSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
        vi.mocked(getSlackWorkspaceLinkRepository).mockReturnValue(linkRepo as any);
        linkRepo.getLinkForTenant.mockResolvedValue(null);
        linkRepo.upsertLink.mockResolvedValue(undefined);
        vi.mocked(TenantConfigService.saveConfig).mockResolvedValue(undefined as any);
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => vi.unstubAllGlobals());

    it('returns 409 on POST when Slack is already configured', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ signingSecret: 'x' } as any);
        const res = await POST(makeRequest({ signingSecret: 's', teamId: 'T1' }));
        expect(res.status).toBe(409);
    });

    it('returns 404 on PUT when Slack is not configured yet', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null);
        const res = await PUT(makeRequest({ signingSecret: 's' }));
        expect(res.status).toBe(404);
    });

    it('returns 400 when signingSecret is missing on create', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null);
        const res = await POST(makeRequest({ teamId: 'T1' }));
        expect(res.status).toBe(400);
    });

    it('verifies a new bot token against Slack and links the resolved team', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null);
        vi.mocked(fetch).mockResolvedValue({
            json: vi.fn().mockResolvedValue({ ok: true, team_id: 'T999', bot_id: 'B1' }),
        } as any);

        const res = await POST(makeRequest({ signingSecret: 's', botToken: 'xoxb-new' }));
        const body = await res.json();

        expect(linkRepo.upsertLink).toHaveBeenCalledWith({ teamId: 'T999', tenantId: 'tenant-1', botUserId: 'B1' });
        expect(res.status).toBe(200);
        expect(body.teamId).toBe('T999');
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'agent.settings.slack_created' })
        );
    });

    it('returns 400 when verifying the bot token throws a non-timeout error', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null);
        vi.mocked(fetch).mockRejectedValue(new Error('network unreachable'));

        const res = await POST(makeRequest({ signingSecret: 's', botToken: 'xoxb-new' }));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.error).toContain('network unreachable');
    });

    it('returns 500 when the workspace link write fails for a reason other than a conflict', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null);
        linkRepo.upsertLink.mockRejectedValue(new Error('connection pool exhausted'));

        const res = await POST(makeRequest({ signingSecret: 's', teamId: 'T1' }));
        expect(res.status).toBe(500);
    });

    it('returns 400 when Slack rejects the bot token', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null);
        vi.mocked(fetch).mockResolvedValue({ json: vi.fn().mockResolvedValue({ ok: false, error: 'invalid_auth' }) } as any);

        const res = await POST(makeRequest({ signingSecret: 's', botToken: 'bad-token' }));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.error).toContain('invalid_auth');
    });

    it('requires a Slack team id when no bot token is provided and none is linked', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null);
        const res = await POST(makeRequest({ signingSecret: 's' }));
        expect(res.status).toBe(400);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('uses the provided teamId directly when no bot token is set', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null);
        const res = await POST(makeRequest({ signingSecret: 's', teamId: 'T555' }));
        expect(linkRepo.upsertLink).toHaveBeenCalledWith({ teamId: 'T555', tenantId: 'tenant-1', botUserId: undefined });
        expect(res.status).toBe(200);
    });

    it('skips link resolution for a bare enabled-toggle call', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ signingSecret: 's', botToken: 'xoxb-1', enabled: true } as any);
        const res = await PUT(makeRequest({ enabled: false }));
        expect(linkRepo.upsertLink).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
        expect(res.status).toBe(200);
    });

    it('returns 409 when the workspace link conflicts with another tenant', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null);
        linkRepo.upsertLink.mockRejectedValue(new SlackWorkspaceLinkConflictError('T1'));

        const res = await POST(makeRequest({ signingSecret: 's', teamId: 'T1' }));
        expect(res.status).toBe(409);
    });

    it('returns 500 when saving throws', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null);
        vi.mocked(TenantConfigService.saveConfig).mockRejectedValue(new Error('DB down'));
        const res = await POST(makeRequest({ signingSecret: 's', teamId: 'T1' }));
        expect(res.status).toBe(500);
    });
});

describe('DELETE /api/agent-ops/settings/slack', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getAuthSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
        vi.mocked(getSlackWorkspaceLinkRepository).mockReturnValue(linkRepo as any);
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await DELETE();
        expect(res).toBe(authError);
    });

    it('resets the config, drops the workspace link, and logs a high-severity audit event', async () => {
        const res = await DELETE();
        const body = await res.json();

        expect(TenantConfigService.deleteConfig).toHaveBeenCalledWith('agent-ops-slack', 'tenant-1');
        expect(linkRepo.deleteLinkForTenant).toHaveBeenCalledWith('tenant-1');
        expect(body).toEqual({ success: true, configured: false, enabled: false });
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'agent.settings.slack_reset', severity: 'high' })
        );
    });

    it('returns 500 when deletion throws', async () => {
        vi.mocked(TenantConfigService.deleteConfig).mockRejectedValue(new Error('DB down'));
        const res = await DELETE();
        expect(res.status).toBe(500);
    });
});
