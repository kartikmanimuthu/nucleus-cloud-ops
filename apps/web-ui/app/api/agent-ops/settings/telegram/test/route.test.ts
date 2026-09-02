import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/tenant-config-service', () => ({ TenantConfigService: { getConfig: vi.fn() } }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));

import { TenantConfigService } from '@/lib/tenant-config-service';
import { getSessionTenantId } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';
import { POST } from './route';

const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;

describe('POST /api/agent-ops/settings/telegram/test', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(authorize).mockResolvedValue(null);
        vi.mocked(getSessionTenantId).mockResolvedValue('tenant-1');
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null);
        vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => vi.unstubAllGlobals());

    it('returns 403 when authorize denies', async () => {
        const { NextResponse } = await import('next/server');
        const authError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        vi.mocked(authorize).mockResolvedValue(authError);

        const res = await POST(makeRequest({ botToken: 'bot-1' }));
        expect(res).toBe(authError);
    });

    it('returns 400 when there is no token to test', async () => {
        const res = await POST(makeRequest({}));
        expect(res.status).toBe(400);
    });

    it('treats an unparsable request body as empty and still reports no token to test', async () => {
        const req = { json: vi.fn().mockRejectedValue(new Error('bad json')) } as any;
        const res = await POST(req);
        expect(res.status).toBe(400);
    });

    it('treats an unparsable getMe response as rejected by Telegram', async () => {
        vi.mocked(fetch).mockResolvedValue({ json: vi.fn().mockRejectedValue(new Error('bad json')) } as any);
        const res = await POST(makeRequest({ botToken: 'bot-1' }));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.error).toContain('unknown error');
    });

    it('treats an unparsable getWebhookInfo response as no webhook set', async () => {
        vi.mocked(fetch)
            .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue({ ok: true, result: { username: 'my_bot' } }) } as any)
            .mockResolvedValueOnce({ json: vi.fn().mockRejectedValue(new Error('bad json')) } as any);

        const res = await POST(makeRequest({ botToken: 'bot-1' }));
        const body = await res.json();
        expect(body.data.webhook.isSet).toBe(false);
    });

    it('returns 400 when Telegram rejects the token', async () => {
        vi.mocked(fetch).mockResolvedValue({ json: vi.fn().mockResolvedValue({ ok: false, description: 'Unauthorized' }) } as any);
        const res = await POST(makeRequest({ botToken: 'bad' }));
        const body = await res.json();
        expect(res.status).toBe(400);
        expect(body.error).toContain('Unauthorized');
    });

    it('returns the bot username and webhook info on success', async () => {
        vi.mocked(fetch)
            .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue({ ok: true, result: { username: 'my_bot' } }) } as any)
            .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue({ ok: true, result: { url: 'https://x.com/hook', pending_update_count: 3 } }) } as any);

        const res = await POST(makeRequest({ botToken: 'bot-1' }));
        const body = await res.json();

        expect(body.data).toEqual({
            botUsername: 'my_bot',
            webhook: { url: 'https://x.com/hook', isSet: true, lastErrorMessage: '', pendingUpdateCount: 3 },
        });
    });

    it('reports isSet: false when no webhook url is registered', async () => {
        vi.mocked(fetch)
            .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue({ ok: true, result: { username: 'my_bot' } }) } as any)
            .mockResolvedValueOnce({ json: vi.fn().mockResolvedValue({ ok: true, result: {} }) } as any);

        const res = await POST(makeRequest({ botToken: 'bot-1' }));
        const body = await res.json();
        expect(body.data.webhook.isSet).toBe(false);
    });

    it('returns 500 with a timeout-specific message on an AbortError', async () => {
        vi.mocked(fetch).mockRejectedValue(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
        const res = await POST(makeRequest({ botToken: 'bot-1' }));
        const body = await res.json();
        expect(res.status).toBe(500);
        expect(body.error).toContain('did not respond');
    });
});
