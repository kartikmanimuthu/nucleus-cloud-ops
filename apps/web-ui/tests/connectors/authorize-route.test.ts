import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ creds: { clientId: 'cid', clientSecret: 'sec', source: 'platform' } as any }));
vi.mock('@/lib/connectors/app-credentials', () => ({ resolveAppCredentials: async () => h.creds }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: async () => 'tenantA' }));
vi.mock('@/lib/rbac/authorize', () => ({ authorize: async () => null }));
vi.mock('@/env', () => ({ env: { NEXTAUTH_SECRET: 's' } }));

import { GET } from '@/app/api/connections/[provider]/authorize/route';

beforeEach(() => { h.creds = { clientId: 'cid', clientSecret: 'sec', source: 'platform' }; });

describe('GET authorize', () => {
    it('redirects to provider consent with state + nonce cookie', async () => {
        const res = await GET(new Request('http://x/api/connections/google/authorize'), { params: Promise.resolve({ provider: 'google' }) } as any);
        expect(res.status).toBe(307);
        const loc = res.headers.get('location')!;
        expect(loc).toContain('accounts.google.com');
        expect(loc).toContain('client_id=cid');
        expect(loc).toContain('state=');
        expect(loc).toContain('access_type=offline');
        expect(res.headers.get('set-cookie')).toContain('connector_oauth_nonce');
    });

    it('400s when app not configured', async () => {
        h.creds = null;
        const res = await GET(new Request('http://x/api/connections/jira/authorize'), { params: Promise.resolve({ provider: 'jira' }) } as any);
        expect(res.status).toBe(400);
    });

    it('400s on unknown provider', async () => {
        const res = await GET(new Request('http://x'), { params: Promise.resolve({ provider: 'nope' }) } as any);
        expect(res.status).toBe(400);
    });
});
