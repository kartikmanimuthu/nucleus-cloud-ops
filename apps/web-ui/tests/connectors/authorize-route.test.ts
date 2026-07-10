import { describe, it, expect, vi, beforeEach } from 'vitest';

let appResult: any = { clientId: 'cid', clientSecretEnc: 'x.y.z' };
vi.mock('@/lib/db/repository-factory', () => ({ getConnectorRepository: () => ({ getApp: async () => appResult }) }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: async () => 'tenantA' }));
vi.mock('@/lib/rbac/authorize', () => ({ authorize: async () => null }));
vi.mock('@/env', () => ({ env: { NEXTAUTH_SECRET: 's' } }));

import { GET } from '@/app/api/connections/[provider]/authorize/route';

beforeEach(() => { appResult = { clientId: 'cid', clientSecretEnc: 'x.y.z' }; });

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
        appResult = null;
        const res = await GET(new Request('http://x/api/connections/jira/authorize'), { params: Promise.resolve({ provider: 'jira' }) } as any);
        expect(res.status).toBe(400);
    });

    it('400s on unknown provider', async () => {
        const res = await GET(new Request('http://x'), { params: Promise.resolve({ provider: 'nope' }) } as any);
        expect(res.status).toBe(400);
    });
});
