import { describe, it, expect, vi } from 'vitest';

const h = vi.hoisted(() => ({ getApp: async () => null as any, platform: false }));
const upsertApp = vi.fn();
vi.mock('@/lib/db/repository-factory', () => ({ getConnectorRepository: () => ({ upsertApp, getApp: h.getApp, deleteApp: vi.fn() }) }));
vi.mock('@/lib/connectors/app-credentials', () => ({ hasPlatformApp: () => h.platform }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: async () => 'tenantA', getAuthSession: async () => ({ user: { email: 'u@x.com' } }) }));
vi.mock('@/lib/rbac/authorize', () => ({ authorize: async () => null }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn(async () => {}) } }));
vi.mock('@/env', () => ({ env: { NEXTAUTH_SECRET: 's' } }));

import { GET, PUT } from '@/app/api/connections/[provider]/app/route';

describe('GET /api/connections/[provider]/app — connectReady', () => {
    it('connectReady via platform app when no tenant app', async () => {
        h.getApp = async () => null; h.platform = true;
        const res = await GET(new Request('http://x/api/connections/jira/app'), { params: Promise.resolve({ provider: 'jira' }) } as any);
        const b = await res.json();
        expect(b.connectReady).toBe(true);
        expect(b.appSource).toBe('platform');
        expect(b.configured).toBe(false); // no BYO app saved
    });
    it('not connectReady when neither tenant nor platform app', async () => {
        h.getApp = async () => null; h.platform = false;
        const res = await GET(new Request('http://x/api/connections/jira/app'), { params: Promise.resolve({ provider: 'jira' }) } as any);
        const b = await res.json();
        expect(b.connectReady).toBe(false);
        expect(b.appSource).toBe('none');
    });
    it('appSource=tenant when a BYO app is saved', async () => {
        h.getApp = async () => ({ clientId: 'cid', clientSecretEnc: 'a.b.c' }); h.platform = false;
        const res = await GET(new Request('http://x/api/connections/jira/app'), { params: Promise.resolve({ provider: 'jira' }) } as any);
        const b = await res.json();
        expect(b.connectReady).toBe(true);
        expect(b.appSource).toBe('tenant');
        expect(b.configured).toBe(true);
    });
});

describe('PUT /api/connections/[provider]/app', () => {
    it('encrypts client secret before saving', async () => {
        const req = new Request('http://x/api/connections/jira/app', { method: 'PUT', body: JSON.stringify({ clientId: 'cid', clientSecret: 'shh' }) });
        const res = await PUT(req, { params: Promise.resolve({ provider: 'jira' }) } as any);
        expect(res.status).toBe(200);
        const saved = upsertApp.mock.calls[0][0];
        expect(saved.clientId).toBe('cid');
        expect(saved.clientSecretEnc).not.toContain('shh');
        expect(saved.clientSecretEnc.split('.')).toHaveLength(3);
    });

    it('400s on unknown provider', async () => {
        const req = new Request('http://x', { method: 'PUT', body: '{}' });
        const res = await PUT(req, { params: Promise.resolve({ provider: 'nope' }) } as any);
        expect(res.status).toBe(400);
    });

    it('400s without clientId', async () => {
        const req = new Request('http://x', { method: 'PUT', body: JSON.stringify({ clientSecret: 'x' }) });
        const res = await PUT(req, { params: Promise.resolve({ provider: 'jira' }) } as any);
        expect(res.status).toBe(400);
    });
});
