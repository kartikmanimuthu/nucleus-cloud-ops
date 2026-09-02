import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/tenant-config-service', () => ({ TenantConfigService: { getConfig: vi.fn(), saveConfig: vi.fn(), deleteConfig: vi.fn() } }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn(), getAuthSession: vi.fn() }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));
vi.mock('@/lib/db/repository-factory', () => ({ getTelegramBotLinkRepository: vi.fn() }));

import { TenantConfigService } from '@/lib/tenant-config-service';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import { authorize } from '@/lib/rbac/authorize';
import { getTelegramBotLinkRepository } from '@/lib/db/repository-factory';
import { TelegramBotLinkConflictError } from '@/lib/db/repositories/telegram-bot-link/interface';
import { GET, POST, PUT, DELETE } from './route';

const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;
const VALID_BODY = { botToken: 'bot-123456', secretToken: 'secret-123456' };
const linkRepo = { deleteLinkForTenant: vi.fn(), upsertLink: vi.fn() };

describe('GET /api/agent-ops/settings/telegram', () => {
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
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ enabled: true, botToken: 'bot-123456', secretToken: 'secret-123456' } as any);
        const res = await GET();
        const body = await res.json();
        expect(body.configured).toBe(true);
        expect(body.botToken).toContain('****');
    });

    it('returns 500 when the config read throws', async () => {
        vi.mocked(TenantConfigService.getConfig).mockRejectedValue(new Error('DB down'));
        const res = await GET();
        expect(res.status).toBe(500);
    });

    it('masks a short secret with all-asterisks and an empty one as an empty string', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ enabled: true, botToken: 'short', secretToken: undefined } as any);
        const res = await GET();
        const body = await res.json();
        expect(body.botToken).toBe('********');
        expect(body.secretToken).toBe('');
    });
});

describe('POST/PUT /api/agent-ops/settings/telegram (save)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getAuthSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
        vi.mocked(getTelegramBotLinkRepository).mockReturnValue(linkRepo as any);
        linkRepo.upsertLink.mockResolvedValue(undefined);
        linkRepo.deleteLinkForTenant.mockResolvedValue(undefined);
        vi.mocked(TenantConfigService.saveConfig).mockResolvedValue(undefined as any);
    });

    it('returns 409 on POST when Telegram is already configured', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ botToken: 'x' } as any);
        const res = await POST(makeRequest(VALID_BODY));
        expect(res.status).toBe(409);
    });

    it('returns 404 on PUT when Telegram is not configured yet', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null);
        const res = await PUT(makeRequest(VALID_BODY));
        expect(res.status).toBe(404);
    });

    it('returns 400 when botToken or secretToken is missing', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null);
        const res = await POST(makeRequest({ botToken: 'x' }));
        expect(res.status).toBe(400);
    });

    it('drops the previous link when the secret token is rotating, then upserts the new one', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ botToken: 'old', secretToken: 'old-secret' } as any);
        const res = await PUT(makeRequest(VALID_BODY));
        const body = await res.json();

        expect(linkRepo.deleteLinkForTenant).toHaveBeenCalledWith('tenant-1');
        expect(linkRepo.upsertLink).toHaveBeenCalledWith({ secretToken: 'secret-123456', tenantId: 'tenant-1' });
        expect(res.status).toBe(200);
        expect(body.success).toBe(true);
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'agent.settings.telegram_updated' })
        );
    });

    it('skips deleting the old link when the secret token is unchanged', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ botToken: 'old', secretToken: 'secret-123456' } as any);
        await PUT(makeRequest({ botToken: 'bot-123456' }));
        expect(linkRepo.deleteLinkForTenant).not.toHaveBeenCalled();
    });

    it('returns 409 when the secret token is already linked to another tenant', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null);
        linkRepo.upsertLink.mockRejectedValue(new TelegramBotLinkConflictError());

        const res = await POST(makeRequest(VALID_BODY));
        expect(res.status).toBe(409);
    });

    it('returns 500 when saving throws', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null);
        vi.mocked(TenantConfigService.saveConfig).mockRejectedValue(new Error('DB down'));
        const res = await POST(makeRequest(VALID_BODY));
        expect(res.status).toBe(500);
    });

    it('returns 500 when the bot-link write fails for a reason other than a conflict', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null);
        linkRepo.upsertLink.mockRejectedValue(new Error('connection pool exhausted'));

        const res = await POST(makeRequest(VALID_BODY));
        expect(res.status).toBe(500);
    });
});

describe('DELETE /api/agent-ops/settings/telegram', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getAuthSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
        vi.mocked(getTelegramBotLinkRepository).mockReturnValue(linkRepo as any);
    });

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await DELETE();
        expect(res).toBe(authError);
    });

    it('resets the config, drops the bot link, and logs a high-severity audit event', async () => {
        const res = await DELETE();
        const body = await res.json();

        expect(TenantConfigService.deleteConfig).toHaveBeenCalledWith('agent-ops-telegram', 'tenant-1');
        expect(linkRepo.deleteLinkForTenant).toHaveBeenCalledWith('tenant-1');
        expect(body).toEqual({ success: true, configured: false, enabled: false });
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'agent.settings.telegram_reset', severity: 'high' })
        );
    });

    it('returns 500 when deletion throws', async () => {
        vi.mocked(TenantConfigService.deleteConfig).mockRejectedValue(new Error('DB down'));
        const res = await DELETE();
        expect(res.status).toBe(500);
    });
});
