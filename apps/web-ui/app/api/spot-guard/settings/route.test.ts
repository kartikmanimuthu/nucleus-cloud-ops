// The tenant_configs 'spot-guard' key is shared by two apps: web-ui reads slackChannelId /
// slackEnabled for alerts, the workers read reportTimezone for the daily report. saveConfig
// overwrites the whole json blob, so the merge in PUT is the load-bearing part of this route —
// without it, saving from a form that omits a field silently resets it.
//
// The timezone check matters for the same reason: the workers' reportTimezoneFor() catches a bad
// zone and falls back to UTC, so an invalid value would look saved and quietly produce reports for
// the wrong day forever. Rejecting it here is the only place a person finds out.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getConfig, saveConfig, authorize, getSessionTenantId, getAuthSession, logUserAction } = vi.hoisted(() => ({
    getConfig: vi.fn(),
    saveConfig: vi.fn(),
    authorize: vi.fn(),
    getSessionTenantId: vi.fn(),
    getAuthSession: vi.fn(),
    logUserAction: vi.fn(),
}));

vi.mock('@/lib/tenant-config-service', () => ({ TenantConfigService: { getConfig, saveConfig } }));
vi.mock('@/lib/rbac/authorize', () => ({ authorize }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId, getAuthSession }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction } }));

import { GET, PUT } from './route';

const TENANT = 'tenant-1';

const put = (body: unknown) =>
    PUT(new Request('http://localhost/api/spot-guard/settings', { method: 'PUT', body: JSON.stringify(body) }));

beforeEach(() => {
    vi.clearAllMocks();
    authorize.mockResolvedValue(null); // null = permitted
    getSessionTenantId.mockResolvedValue(TENANT);
    getAuthSession.mockResolvedValue({ user: { email: 'dev@local.test' } });
    getConfig.mockResolvedValue(null);
    saveConfig.mockResolvedValue(undefined);
    logUserAction.mockResolvedValue(undefined);
});

describe('GET /api/spot-guard/settings', () => {
    it('returns empty defaults when nothing is configured', async () => {
        const body = await (await GET()).json();

        expect(body.success).toBe(true);
        expect(body.data).toEqual({ slackChannelId: '', slackEnabled: true, reportTimezone: '' });
    });

    it('treats a missing slackEnabled as ON, matching notify()', async () => {
        // notify() only suppresses on an explicit `slackEnabled === false`, so the UI must not
        // render an unset value as "muted" — that would misreport the live behaviour.
        getConfig.mockResolvedValue({ slackChannelId: 'C123456789' });

        const body = await (await GET()).json();

        expect(body.data.slackEnabled).toBe(true);
    });

    it('returns what is stored', async () => {
        getConfig.mockResolvedValue({ slackChannelId: '#cloud-ops', slackEnabled: false, reportTimezone: 'Asia/Kolkata' });

        const body = await (await GET()).json();

        expect(body.data).toEqual({ slackChannelId: '#cloud-ops', slackEnabled: false, reportTimezone: 'Asia/Kolkata' });
    });

    it('is refused without read permission', async () => {
        authorize.mockResolvedValue(new Response('forbidden', { status: 403 }));

        const res = await GET();

        expect(res.status).toBe(403);
        expect(getConfig).not.toHaveBeenCalled();
    });

    it('returns 500 when reading the config throws', async () => {
        getConfig.mockRejectedValue(new Error('DB down'));

        const res = await GET();

        expect(res.status).toBe(500);
    });
});

describe('PUT /api/spot-guard/settings — merging', () => {
    it('does NOT wipe reportTimezone when only the channel is sent', async () => {
        // The exact regression: the Slack card saves, and the workers lose the timezone.
        getConfig.mockResolvedValue({ reportTimezone: 'Asia/Kolkata', slackEnabled: false });

        await put({ slackChannelId: 'C0123456789' });

        expect(saveConfig.mock.calls[0][1]).toEqual({
            reportTimezone: 'Asia/Kolkata',
            slackEnabled: false,
            slackChannelId: 'C0123456789',
        });
    });

    it('does NOT wipe the channel when only the timezone is sent', async () => {
        getConfig.mockResolvedValue({ slackChannelId: 'C0123456789' });

        await put({ reportTimezone: 'Europe/London' });

        expect(saveConfig.mock.calls[0][1]).toEqual({
            slackChannelId: 'C0123456789',
            reportTimezone: 'Europe/London',
        });
    });

    it('preserves fields it knows nothing about', async () => {
        // Someone adds a field to the key later; this route must not be the thing that eats it.
        getConfig.mockResolvedValue({ someFutureSetting: 42 });

        await put({ slackEnabled: false });

        expect(saveConfig.mock.calls[0][1]).toMatchObject({ someFutureSetting: 42, slackEnabled: false });
    });

    it('saves under the right key, tenant and actor', async () => {
        await put({ slackChannelId: 'C0123456789' });

        const [key, , tenantId, actor] = saveConfig.mock.calls[0];
        expect(key).toBe('spot-guard');
        expect(tenantId).toBe(TENANT);
        expect(actor).toBe('dev@local.test');
    });
});

describe('PUT /api/spot-guard/settings — validation', () => {
    it.each(['C0123456789', 'G01ABCDEFGH', '#cloud-ops', '#ops.alerts-1', ''])('accepts %s as a channel', async (v) => {
        const res = await put({ slackChannelId: v });
        expect(res.status).toBe(200);
    });

    it.each(['cloud-ops', 'general', 'C123', 'https://slack.com/x', 'c0123456789'])('rejects %s as a channel', async (v) => {
        const res = await put({ slackChannelId: v });
        const body = await res.json();

        expect(res.status).toBe(400);
        expect(body.error).toMatch(/channel ID/i);
        expect(saveConfig).not.toHaveBeenCalled();
    });

    // 'IST' and 'EST' are legacy ICU aliases that resolve to real offsets (+05:30, -05:00) and the
    // workers format through the same Intl, so they work end to end. Blocking them would be an
    // invented rule; the form's placeholder steers toward canonical names.
    it.each(['Asia/Kolkata', 'Europe/London', 'UTC', 'IST', ''])('accepts %s as a timezone', async (v) => {
        const res = await put({ reportTimezone: v });
        expect(res.status).toBe(200);
    });

    it.each(['Asia/Bangalore', 'GMT+5:30', 'Mars/Olympus', 'Kolkata'])('rejects %s as a timezone', async (v) => {
        const res = await put({ reportTimezone: v });
        const body = await res.json();

        expect(res.status).toBe(400);
        expect(body.error).toMatch(/IANA/i);
        expect(saveConfig).not.toHaveBeenCalled();
    });

    it('is refused without update permission', async () => {
        authorize.mockResolvedValue(new Response('forbidden', { status: 403 }));

        const res = await put({ slackChannelId: 'C0123456789' });

        expect(res.status).toBe(403);
        expect(saveConfig).not.toHaveBeenCalled();
    });

    it('saves even if the audit write fails', async () => {
        // Losing the audit line is bad; refusing the save because of it is worse.
        logUserAction.mockRejectedValue(new Error('audit table down'));

        const res = await put({ slackChannelId: 'C0123456789' });

        expect(res.status).toBe(200);
        expect(saveConfig).toHaveBeenCalledTimes(1);
    });

    it('treats an unparsable request body as an empty object', async () => {
        const req = { json: vi.fn().mockRejectedValue(new Error('invalid JSON')) } as any;
        const res = await PUT(req);
        // An empty body has every field optional, so it validates and saves the existing config unchanged.
        expect(res.status).toBe(200);
    });

    it('returns 500 when saving throws', async () => {
        saveConfig.mockRejectedValue(new Error('DB down'));

        const res = await put({ slackChannelId: 'C0123456789' });

        expect(res.status).toBe(500);
    });
});
