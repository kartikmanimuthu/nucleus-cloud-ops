import { describe, it, expect, vi } from 'vitest';
vi.mock('@/env', () => ({ env: { NEXTAUTH_SECRET: 's' } }));
import { encryptJson } from '@/lib/crypto/provider-credentials';

const updateConnectionTokens = vi.fn();
let active: any;
vi.mock('@/lib/db/repository-factory', () => ({ getConnectorRepository: () => ({
    getActiveConnection: async () => active,
    getApp: async () => ({ clientId: 'cid', clientSecretEnc: encryptJson('secret'), botTokenEnc: encryptJson('xoxb-9') }),
    updateConnectionTokens,
}) }));
vi.mock('@/lib/connectors/token-exchange', () => ({ refreshAccessToken: async () => ({ accessToken: 'fresh', refreshToken: 'rt2', expiresInSec: 3600, scopes: [] }) }));

import { getUsableAccessToken, getBotToken } from '@/lib/connectors/connection-service';

describe('connection-service', () => {
    it('returns a valid token as-is', async () => {
        active = { id: 'c1', accessTokenEnc: encryptJson('valid'), refreshTokenEnc: null, expiresAt: new Date(Date.now() + 600_000), metadata: { cloudId: 'x' } };
        const r = await getUsableAccessToken('jira', 't1');
        expect(r?.accessToken).toBe('valid');
        expect(r?.metadata.cloudId).toBe('x');
    });
    it('refreshes an expired token', async () => {
        active = { id: 'c1', accessTokenEnc: encryptJson('stale'), refreshTokenEnc: encryptJson('rt'), expiresAt: new Date(Date.now() - 1000), metadata: {} };
        const r = await getUsableAccessToken('jira', 't1');
        expect(r?.accessToken).toBe('fresh');
        expect(updateConnectionTokens).toHaveBeenCalled();
    });
    it('returns null with no active connection', async () => {
        active = null;
        expect(await getUsableAccessToken('google', 't1')).toBeNull();
    });
    it('decrypts the bot token', async () => {
        expect(await getBotToken('t1')).toBe('xoxb-9');
    });
});
