import { describe, it, expect, vi } from 'vitest';
const listConnections = vi.fn(async () => [{ id: 'c1', accountLabel: 'Acme', scopes: ['a'], status: 'active', tokenType: 'user', accessTokenEnc: 'SECRET', expiresAt: null, createdAt: new Date() }]);
const deleteConnection = vi.fn();
vi.mock('@/lib/db/repository-factory', () => ({ getConnectorRepository: () => ({ listConnections, deleteConnection }) }));
vi.mock('@/lib/auth-session', () => ({ getSessionTenantId: async () => 'tenantA', getAuthSession: async () => ({ user: { email: 'u' } }) }));
vi.mock('@/lib/rbac/authorize', () => ({ authorize: async () => null }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn(async () => {}) } }));

import { GET } from '@/app/api/connections/[provider]/route';
import { DELETE } from '@/app/api/connections/[provider]/[id]/route';

describe('connections routes', () => {
    it('lists connections without tokens', async () => {
        const res = await GET(new Request('http://x'), { params: Promise.resolve({ provider: 'jira' }) } as any);
        const body = await res.json();
        expect(body.connections[0].id).toBe('c1');
        expect(JSON.stringify(body)).not.toContain('SECRET');
    });
    it('deletes a connection', async () => {
        const res = await DELETE(new Request('http://x', { method: 'DELETE' }), { params: Promise.resolve({ provider: 'jira', id: 'c1' }) } as any);
        expect(res.status).toBe(200);
        expect(deleteConnection).toHaveBeenCalledWith('c1', 'tenantA');
    });
});
