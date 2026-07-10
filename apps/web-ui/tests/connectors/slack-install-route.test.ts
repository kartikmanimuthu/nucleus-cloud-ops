import { describe, it, expect, vi } from 'vitest';
const upsertApp = vi.fn();
vi.mock('@/lib/db/repository-factory', () => ({ getConnectorRepository: () => ({ getApp: async () => ({ clientId: 'cid', clientSecretEnc: 'x' }), upsertApp }) }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: async () => 'tenantA' }));
vi.mock('@/lib/rbac/authorize', () => ({ authorize: async () => null }));
vi.mock('@/lib/connectors/token-exchange', () => ({ exchangeSlackBot: async () => ({ botToken: 'xoxb-1', teamName: 'Acme', teamId: 'T1', botUserId: 'B1', scopes: ['chat:write'] }) }));
vi.mock('@/env', () => ({ env: { NEXTAUTH_SECRET: 's' } }));
import { signState } from '@/lib/connectors/oauth-state';
import { GET as install } from '@/app/api/slack/install/route';
import { GET as cb } from '@/app/api/slack/install/callback/route';

describe('slack install', () => {
    it('redirects with bot scope', async () => {
        const res = await install(new Request('http://x/api/slack/install'));
        expect(res.status).toBe(307);
        expect(res.headers.get('location')).toContain('scope=');
        expect(res.headers.get('set-cookie')).toContain('connector_install_nonce');
    });
    it('stores the bot token on callback', async () => {
        const state = signState({ tenantId: 'tenantA', provider: 'slack', nonce: 'n1' });
        const req = new Request(`http://x/api/slack/install/callback?code=c&state=${encodeURIComponent(state)}`, { headers: { cookie: 'connector_install_nonce=n1' } });
        const res = await cb(req);
        expect(res.status).toBe(307);
        const saved = upsertApp.mock.calls[0][0];
        expect(saved.botTokenEnc).not.toContain('xoxb-1');
        expect(saved.botAccountLabel).toBe('Acme');
    });
});
