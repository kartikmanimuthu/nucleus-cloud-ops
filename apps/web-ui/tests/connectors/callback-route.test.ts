import { describe, it, expect, vi } from 'vitest';
const upsertConnection = vi.fn((..._args: any[]) => Promise.resolve({ id: 'c1' }));
vi.mock('@/lib/db/repository-factory', () => ({ getConnectorRepository: () => ({ getApp: async () => ({ clientId: 'cid', clientSecretEnc: 'x' }), upsertConnection }) }));
vi.mock('@/lib/connectors/token-exchange', () => ({
    exchangeCode: async () => ({ accessToken: 'at', refreshToken: 'rt', expiresInSec: 3600, scopes: ['read:jira-work'] }),
    fetchIdentity: async () => ({ accountLabel: 'Acme', externalAccountId: 'cloud1', metadata: { cloudId: 'cloud1' } }),
}));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn(async () => {}) } }));
vi.mock('@/env', () => ({ env: { NEXTAUTH_SECRET: 's' } }));
import { signState } from '@/lib/connectors/oauth-state';
import { GET } from '@/app/api/connections/[provider]/callback/route';

function reqWith(state: string, nonce: string) {
    return new Request(`http://x/api/connections/jira/callback?code=abc&state=${encodeURIComponent(state)}`, { headers: { cookie: `connector_oauth_nonce=${nonce}` } });
}

describe('GET callback', () => {
    it('stores an encrypted connection and redirects with connected=1', async () => {
        const state = signState({ tenantId: 'tenantA', provider: 'jira', nonce: 'n1' });
        const res = await GET(reqWith(state, 'n1'), { params: Promise.resolve({ provider: 'jira' }) } as any);
        expect(res.status).toBe(307);
        expect(res.headers.get('location')).toContain('connected=1');
        const saved = upsertConnection.mock.calls[0][0];
        expect(saved.accessTokenEnc).not.toContain('at');
        expect(saved.externalAccountId).toBe('cloud1');
    });

    it('rejects a nonce mismatch', async () => {
        const state = signState({ tenantId: 'tenantA', provider: 'jira', nonce: 'n1' });
        const res = await GET(reqWith(state, 'WRONG'), { params: Promise.resolve({ provider: 'jira' }) } as any);
        expect(res.headers.get('location')).toContain('error=');
    });
});
