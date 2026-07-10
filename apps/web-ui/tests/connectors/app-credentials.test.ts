import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ envMock: {} as Record<string, string | undefined>, appRow: null as any }));
const envMock = h.envMock;
vi.mock('@/env', () => ({ env: h.envMock }));
vi.mock('@/lib/db/repository-factory', () => ({ getConnectorRepository: () => ({ getApp: async () => h.appRow }) }));

// encryptJson/decryptJson use env.NEXTAUTH_SECRET; set it for the crypto path.
import { encryptJson } from '@/lib/crypto/provider-credentials';
import { resolveAppCredentials, hasPlatformApp } from '@/lib/connectors/app-credentials';

beforeEach(() => {
    for (const k of Object.keys(envMock)) delete envMock[k];
    envMock.NEXTAUTH_SECRET = 's';
    h.appRow = null;
});

describe('resolveAppCredentials', () => {
    it('prefers a tenant BYO app when present', async () => {
        h.appRow = { clientId: 'tenant-cid', clientSecretEnc: encryptJson('tenant-secret'), signingSecretEnc: encryptJson('sign') };
        envMock.JIRA_OAUTH_CLIENT_ID = 'platform-cid';
        envMock.JIRA_OAUTH_CLIENT_SECRET = 'platform-secret';
        const r = await resolveAppCredentials('jira', 't1');
        expect(r).toEqual({ clientId: 'tenant-cid', clientSecret: 'tenant-secret', signingSecret: 'sign', source: 'tenant' });
    });

    it('falls back to the platform app when no tenant app', async () => {
        envMock.GOOGLE_OAUTH_CLIENT_ID = 'p-cid';
        envMock.GOOGLE_OAUTH_CLIENT_SECRET = 'p-secret';
        const r = await resolveAppCredentials('google', 't1');
        expect(r).toEqual({ clientId: 'p-cid', clientSecret: 'p-secret', signingSecret: undefined, source: 'platform' });
    });

    it('uses env SLACK_SIGNING_SECRET for the platform Slack app', async () => {
        envMock.SLACK_OAUTH_CLIENT_ID = 'p';
        envMock.SLACK_OAUTH_CLIENT_SECRET = 'ps';
        envMock.SLACK_SIGNING_SECRET = 'sig';
        const r = await resolveAppCredentials('slack', 't1');
        expect(r?.source).toBe('platform');
        expect(r?.signingSecret).toBe('sig');
    });

    it('returns null when neither tenant nor platform creds exist', async () => {
        expect(await resolveAppCredentials('jira', 't1')).toBeNull();
    });

    it('ignores a tenant row missing a client secret and uses platform', async () => {
        h.appRow = { clientId: 'tenant-cid', clientSecretEnc: null };
        envMock.JIRA_OAUTH_CLIENT_ID = 'p';
        envMock.JIRA_OAUTH_CLIENT_SECRET = 'ps';
        const r = await resolveAppCredentials('jira', 't1');
        expect(r?.source).toBe('platform');
    });

    it('hasPlatformApp reflects env presence', () => {
        expect(hasPlatformApp('jira')).toBe(false);
        envMock.JIRA_OAUTH_CLIENT_ID = 'p';
        envMock.JIRA_OAUTH_CLIENT_SECRET = 'ps';
        expect(hasPlatformApp('jira')).toBe(true);
    });
});
