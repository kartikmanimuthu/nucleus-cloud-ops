import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/tenant-config-service', () => ({ TenantConfigService: { getConfig: vi.fn() } }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn(), getAuthSession: vi.fn() }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));

import { TenantConfigService } from '@/lib/tenant-config-service';
import { getSessionTenantId, getAuthSession } from '@/lib/auth-session';
import { AuditService } from '@/lib/audit-service';
import { authorize } from '@/lib/rbac/authorize';
import { POST } from './route';

const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;
const VALID_BODY = { webhookUrl: 'https://example.com/hook', botToken: 'bot-1', secretToken: 'secret-1' };

describe('POST /api/agent-ops/settings/telegram/webhook', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(getAuthSession).mockResolvedValue({ user: { email: 'a@b.co' } } as any);
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null);
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => vi.unstubAllGlobals());

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await POST(makeRequest(VALID_BODY));
        expect(res).toBe(authError);
    });

    it('returns 400 when botToken or secretToken is missing', async () => {
        const res = await POST(makeRequest({ webhookUrl: 'https://example.com/hook' }));
        expect(res.status).toBe(400);
    });

    it('treats an unparsable request body as empty and still reports missing credentials', async () => {
        const req = { json: vi.fn().mockRejectedValue(new Error('bad json')) } as any;
        const res = await POST(req);
        expect(res.status).toBe(400);
    });

    it('treats an unparsable setWebhook response as a rejected registration', async () => {
        vi.mocked(fetch).mockResolvedValue({ json: vi.fn().mockRejectedValue(new Error('bad json')) } as any);
        const res = await POST(makeRequest(VALID_BODY));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.error).toContain('unknown error');
    });

    it('returns 400 when the webhook URL is not https', async () => {
        const res = await POST(makeRequest({ ...VALID_BODY, webhookUrl: 'http://example.com/hook' }));
        expect(res.status).toBe(400);
    });

    it('falls back to the stored bot token and secret when the body omits them', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ botToken: 'stored-bot', secretToken: 'stored-secret' } as any);
        vi.mocked(fetch).mockResolvedValue({ json: vi.fn().mockResolvedValue({ ok: true }) } as any);

        const res = await POST(makeRequest({ webhookUrl: 'https://example.com/hook' }));
        expect(res.status).toBe(200);
    });

    it('returns 400 when Telegram rejects the webhook registration', async () => {
        vi.mocked(fetch).mockResolvedValue({ json: vi.fn().mockResolvedValue({ ok: false, description: 'bad url' }) } as any);
        const res = await POST(makeRequest(VALID_BODY));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.error).toContain('bad url');
    });

    it('registers the webhook and logs an audit event', async () => {
        vi.mocked(fetch).mockResolvedValue({ json: vi.fn().mockResolvedValue({ ok: true }) } as any);
        const res = await POST(makeRequest(VALID_BODY));
        const body = await res.json();

        expect(fetch).toHaveBeenCalledWith(
            expect.stringContaining('/bot bot-1/setWebhook'.replace(' ', '')),
            expect.objectContaining({ method: 'POST' }),
        );
        expect(res.status).toBe(200);
        expect(body).toEqual({ success: true, data: { url: 'https://example.com/hook' } });
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'agent.settings.telegram_webhook_registered' })
        );
    });

    it('returns 500 with a timeout-specific message on an AbortError', async () => {
        vi.mocked(fetch).mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        const res = await POST(makeRequest(VALID_BODY));
        const body = await res.json();
        expect(res.status).toBe(500);
        expect(body.error).toContain('did not respond');
    });
});
