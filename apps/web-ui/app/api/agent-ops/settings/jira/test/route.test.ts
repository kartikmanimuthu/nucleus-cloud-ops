import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/tenant-config-service', () => ({ TenantConfigService: { getConfig: vi.fn() } }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: vi.fn() }));
vi.mock('@/lib/rbac/authorize', () => ({ authorize: vi.fn() }));

import { TenantConfigService } from '@/lib/tenant-config-service';
import { getSessionTenantId } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';
import { POST } from './route';

const makeRequest = (body: unknown) => ({ json: vi.fn().mockResolvedValue(body) }) as any;
const VALID_BODY = { baseUrl: 'https://x.atlassian.net', userEmail: 'a@b.co', apiToken: 'tok' };

describe('POST /api/agent-ops/settings/jira/test', () => {
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

        const res = await POST(makeRequest(VALID_BODY));
        expect(res).toBe(authError);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('returns 400 when required fields are missing', async () => {
        const res = await POST(makeRequest({ baseUrl: 'https://x.atlassian.net' }));
        expect(res.status).toBe(400);
    });

    it('treats an unparsable request body as empty and falls through to the missing-fields check', async () => {
        const req = { json: vi.fn().mockRejectedValue(new Error('bad json')) } as any;
        const res = await POST(req);
        expect(res.status).toBe(400);
    });

    it('treats an unparsable /myself response as an empty result set', async () => {
        vi.mocked(fetch).mockResolvedValue({ status: 200, ok: true, json: vi.fn().mockRejectedValue(new Error('bad json')) } as any);
        const res = await POST(makeRequest(VALID_BODY));
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body.data).toEqual({ displayName: '', accountId: '', emailAddress: '' });
    });

    it('returns 400 when the base URL is not https', async () => {
        const res = await POST(makeRequest({ ...VALID_BODY, baseUrl: 'http://x.atlassian.net' }));
        expect(res.status).toBe(400);
    });

    it('returns 400 when Jira rejects credentials', async () => {
        vi.mocked(fetch).mockResolvedValue({ status: 401, ok: false } as any);
        const res = await POST(makeRequest(VALID_BODY));
        expect(res.status).toBe(400);
    });

    it('returns 400 for a non-2xx, non-401/403 response', async () => {
        vi.mocked(fetch).mockResolvedValue({ status: 500, ok: false } as any);
        const res = await POST(makeRequest(VALID_BODY));
        expect(res.status).toBe(400);
    });

    it('returns the account details on success', async () => {
        vi.mocked(fetch).mockResolvedValue({
            status: 200, ok: true,
            json: vi.fn().mockResolvedValue({ displayName: 'Bot User', accountId: 'acc-1', emailAddress: 'bot@x.co' }),
        } as any);

        const res = await POST(makeRequest(VALID_BODY));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body).toEqual({ success: true, data: { displayName: 'Bot User', accountId: 'acc-1', emailAddress: 'bot@x.co' } });
    });

    it('falls back to the stored config for blank fields', async () => {
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ baseUrl: 'https://x.atlassian.net', userEmail: 'a@b.co', apiToken: 'tok' } as any);
        vi.mocked(fetch).mockResolvedValue({ status: 200, ok: true, json: vi.fn().mockResolvedValue({}) } as any);

        const res = await POST(makeRequest({}));
        expect(res.status).toBe(200);
    });

    it('returns 500 with a timeout-specific message on an AbortError', async () => {
        vi.mocked(fetch).mockRejectedValue(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
        const res = await POST(makeRequest(VALID_BODY));
        const body = await res.json();
        expect(res.status).toBe(500);
        expect(body.error).toContain('did not respond');
    });
});
