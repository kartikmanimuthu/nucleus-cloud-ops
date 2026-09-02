import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth-session', () => ({ getAuthSession: vi.fn() }));
vi.mock('@/lib/db/pg-config', () => ({ getPrismaClient: vi.fn() }));
vi.mock('@/lib/tenant-config-service', () => ({ TenantConfigService: { getConfig: vi.fn() } }));

import { getAuthSession } from '@/lib/auth-session';
import { getPrismaClient } from '@/lib/db/pg-config';
import { TenantConfigService } from '@/lib/tenant-config-service';
import { GET } from './route';

describe('GET /api/tenants/my-orgs', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getAuthSession).mockResolvedValue({ user: { id: 'u1' } } as any);
    });

    it('returns 401 when unauthenticated', async () => {
        vi.mocked(getAuthSession).mockResolvedValue(null as any);
        const res = await GET();
        expect(res.status).toBe(401);
    });

    it('returns an empty orgs list when the user has no memberships', async () => {
        vi.mocked(getPrismaClient).mockReturnValue({
            userTenantRole: { findMany: vi.fn().mockResolvedValue([]) },
        } as any);

        const res = await GET();
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.orgs).toEqual([]);
    });

    it('returns orgs with role and logoUrl merged in', async () => {
        vi.mocked(getPrismaClient).mockReturnValue({
            userTenantRole: {
                findMany: vi.fn().mockResolvedValue([{ tenantId: 't1', role: 'Owner' }]),
            },
            tenant: {
                findMany: vi.fn().mockResolvedValue([{ id: 't1', name: 'Acme', slug: 'acme' }]),
            },
        } as any);
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue({ key: 'org_logo', url: 'https://cdn/logo.png' });

        const res = await GET();
        const body = await res.json();

        expect(body.orgs).toEqual([
            { id: 't1', name: 'Acme', slug: 'acme', role: 'Owner', logoUrl: 'https://cdn/logo.png' },
        ]);
    });

    it('defaults logoUrl to null when no logo config exists', async () => {
        vi.mocked(getPrismaClient).mockReturnValue({
            userTenantRole: { findMany: vi.fn().mockResolvedValue([{ tenantId: 't1', role: 'Member' }]) },
            tenant: { findMany: vi.fn().mockResolvedValue([{ id: 't1', name: 'Acme', slug: 'acme' }]) },
        } as any);
        vi.mocked(TenantConfigService.getConfig).mockResolvedValue(null);

        const res = await GET();
        const body = await res.json();

        expect(body.orgs[0].logoUrl).toBeNull();
    });

    it('returns 500 when the database call throws', async () => {
        vi.mocked(getPrismaClient).mockReturnValue({
            userTenantRole: { findMany: vi.fn().mockRejectedValue(new Error('DB down')) },
        } as any);

        const res = await GET();
        expect(res.status).toBe(500);
    });
});
