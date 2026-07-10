import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('@/env', () => ({ env: { NEXTAUTH_SECRET: 's' } }));
import { encryptJson } from '@/lib/crypto/provider-credentials';
import { exchangeCode, fetchIdentity, refreshAccessToken } from '@/lib/connectors/token-exchange';

const app = { clientId: 'cid', clientSecretEnc: encryptJson('secret') } as any;

beforeEach(() => vi.restoreAllMocks());

describe('token-exchange', () => {
    it('exchanges a google code', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => ({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'a b' }),
        })) as any);
        const res = await exchangeCode('google', app, 'code', 'https://x/cb');
        expect(res.accessToken).toBe('at');
        expect(res.refreshToken).toBe('rt');
        expect(res.scopes).toEqual(['a', 'b']);
    });

    it('reads the slack user token from authed_user', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => ({ ok: true, authed_user: { access_token: 'xoxp-1', scope: 'chat:write,users:read' } }),
        })) as any);
        const res = await exchangeCode('slack', app, 'code', 'https://x/cb');
        expect(res.accessToken).toBe('xoxp-1');
        expect(res.scopes).toEqual(['chat:write', 'users:read']);
    });

    it('throws on token error', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) })) as any);
        await expect(exchangeCode('google', app, 'bad', 'https://x/cb')).rejects.toThrow(/invalid_grant/);
    });

    it('refreshes an access token', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ access_token: 'new', expires_in: 3600 }) })) as any);
        const res = await refreshAccessToken('google', app, 'rt');
        expect(res.accessToken).toBe('new');
        expect(res.refreshToken).toBe('rt'); // preserved when not re-issued
    });

    it('reads jira identity from accessible-resources', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => ([{ id: 'cloud1', name: 'Acme', url: 'https://acme.atlassian.net' }]),
        })) as any);
        const id = await fetchIdentity('jira', 'at');
        expect(id.externalAccountId).toBe('cloud1');
        expect(id.metadata.apiBaseUrl).toBe('https://api.atlassian.com/ex/jira/cloud1');
    });

    it('reads google identity from userinfo', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ sub: 'sub1', email: 'x@y.com' }) })) as any);
        const id = await fetchIdentity('google', 'at');
        expect(id.accountLabel).toBe('x@y.com');
        expect(id.externalAccountId).toBe('sub1');
    });
});
