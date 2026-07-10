import { describe, it, expect, vi } from 'vitest';

const upsertApp = vi.fn();
vi.mock('@/lib/db/repository-factory', () => ({ getConnectorRepository: () => ({ upsertApp, getApp: vi.fn(), deleteApp: vi.fn() }) }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: async () => 'tenantA', getAuthSession: async () => ({ user: { email: 'u@x.com' } }) }));
vi.mock('@/lib/rbac/authorize', () => ({ authorize: async () => null }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn(async () => {}) } }));
vi.mock('@/env', () => ({ env: { NEXTAUTH_SECRET: 's' } }));

import { PUT } from '@/app/api/connections/[provider]/app/route';

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
