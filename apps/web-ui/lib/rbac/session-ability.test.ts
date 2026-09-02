import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth-session', () => ({ getAuthSession: vi.fn() }));
vi.mock('@/lib/db/pg-config', () => ({ getPrismaClient: vi.fn(), getTenantClient: vi.fn() }));
vi.mock('./ability-cache', () => ({ getAbilityForPrincipal: vi.fn(), getRbacVersion: vi.fn() }));
vi.mock('./registry', () => ({ resolveRoleIdByName: vi.fn() }));

import { getPrismaClient, getTenantClient } from '@/lib/db/pg-config';
import { getRbacVersion } from './ability-cache';
import { resolveRoleIdByName } from './registry';
import { buildPrincipalFor } from './session-ability';

const mockPrisma = {
    userTenantRole: { findUnique: vi.fn() },
    customRole: { findUnique: vi.fn() },
};
const mockTenantDb = { rbacUserAttribute: { findMany: vi.fn() } };

// buildPrincipalFor caches by `${tenantId}:${userId}:${version}` in a module-level
// Map, so every test needs its own tenantId — reusing one across tests returns a
// stale cached principal instead of exercising that test's mocked query result.
let tenantCounter = 0;
const freshTenantId = () => `tenant-${++tenantCounter}`;

describe('buildPrincipalFor', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as any);
        vi.mocked(getTenantClient).mockReturnValue(mockTenantDb as any);
        vi.mocked(getRbacVersion).mockResolvedValue(1);
        mockTenantDb.rbacUserAttribute.findMany.mockResolvedValue([]);
    });

    it('returns null when userId is missing', async () => {
        expect(await buildPrincipalFor({ userId: '', email: 'a@b.co', tenantId: freshTenantId(), roleName: null, isSuperAdmin: false })).toBeNull();
    });

    it('returns null when tenantId is missing', async () => {
        expect(await buildPrincipalFor({ userId: 'u1', email: 'a@b.co', tenantId: '', roleName: null, isSuperAdmin: false })).toBeNull();
    });

    it('prefers the membership.customRole when present, over the name column', async () => {
        mockPrisma.userTenantRole.findUnique.mockResolvedValue({
            roleId: 'legacy-role-id', role: 'Owner',
            customRole: { id: 'custom-1', name: 'Cloud Admin', level: 5 },
        });

        const principal = await buildPrincipalFor({ userId: 'u1', email: 'a@b.co', tenantId: freshTenantId(), roleName: 'Owner', isSuperAdmin: false });

        expect(principal).toEqual(expect.objectContaining({ roleId: 'custom-1', roleName: 'Cloud Admin', level: 5 }));
        expect(resolveRoleIdByName).not.toHaveBeenCalled();
    });

    it('falls back to the membership.role name and resolves its role id when there is no customRole', async () => {
        mockPrisma.userTenantRole.findUnique.mockResolvedValue({ roleId: 'role-id-1', role: 'Admin', customRole: null });
        vi.mocked(resolveRoleIdByName).mockResolvedValue('role-id-1');
        mockPrisma.customRole.findUnique.mockResolvedValue({ level: 3 });
        const tenantId = freshTenantId();

        const principal = await buildPrincipalFor({ userId: 'u1', email: 'a@b.co', tenantId, roleName: null, isSuperAdmin: false });

        expect(resolveRoleIdByName).toHaveBeenCalledWith(tenantId, 'Admin');
        expect(principal).toEqual(expect.objectContaining({ roleId: 'role-id-1', roleName: 'Admin', level: 3 }));
    });

    it('falls back to the identity roleName when there is no membership row at all', async () => {
        mockPrisma.userTenantRole.findUnique.mockResolvedValue(null);
        vi.mocked(resolveRoleIdByName).mockResolvedValue('role-id-2');
        mockPrisma.customRole.findUnique.mockResolvedValue({ level: 1 });
        const tenantId = freshTenantId();

        const principal = await buildPrincipalFor({ userId: 'u1', email: 'a@b.co', tenantId, roleName: 'Viewer', isSuperAdmin: false });

        expect(resolveRoleIdByName).toHaveBeenCalledWith(tenantId, 'Viewer');
        expect(principal?.roleName).toBe('Viewer');
    });

    it('resolves to no role (deny by default) when neither membership nor identity carries a name', async () => {
        mockPrisma.userTenantRole.findUnique.mockResolvedValue(null);

        const principal = await buildPrincipalFor({ userId: 'u1', email: 'a@b.co', tenantId: freshTenantId(), roleName: null, isSuperAdmin: false });

        expect(principal).toEqual(expect.objectContaining({ roleId: null, roleName: '', level: 0 }));
        expect(resolveRoleIdByName).not.toHaveBeenCalled();
    });

    it('denies by default when the resolved name has no matching role row', async () => {
        mockPrisma.userTenantRole.findUnique.mockResolvedValue({ roleId: null, role: 'Ghost Role', customRole: null });
        vi.mocked(resolveRoleIdByName).mockResolvedValue(null);

        const principal = await buildPrincipalFor({ userId: 'u1', email: 'a@b.co', tenantId: freshTenantId(), roleName: null, isSuperAdmin: false });

        expect(principal).toEqual(expect.objectContaining({ roleId: null, roleName: 'Ghost Role', level: 0 }));
    });

    it('includes user.roleId in attributes only when a roleId was resolved', async () => {
        mockPrisma.userTenantRole.findUnique.mockResolvedValue({ roleId: 'r1', role: 'Owner', customRole: { id: 'r1', name: 'Owner', level: 5 } });
        const tenantId = freshTenantId();

        const principal = await buildPrincipalFor({ userId: 'u1', email: 'a@b.co', tenantId, roleName: null, isSuperAdmin: false });

        expect(principal?.attributes).toEqual(expect.objectContaining({
            'user.id': 'u1', 'user.email': 'a@b.co', 'user.tenantId': tenantId, 'user.roleId': 'r1',
        }));
    });

    it('merges admin-assigned attributes, namespacing keys that lack a "user." prefix', async () => {
        mockPrisma.userTenantRole.findUnique.mockResolvedValue(null);
        mockTenantDb.rbacUserAttribute.findMany.mockResolvedValue([
            { key: 'allowedAccountIds', value: ['acc-1'] },
            { key: 'user.department', value: 'ops' },
        ]);

        const principal = await buildPrincipalFor({ userId: 'u1', email: 'a@b.co', tenantId: freshTenantId(), roleName: null, isSuperAdmin: false });

        expect(principal?.attributes).toEqual(expect.objectContaining({
            'user.allowedAccountIds': ['acc-1'], 'user.department': 'ops',
        }));
    });

    it('caches the principal across calls with the same identity and RBAC version, skipping re-query', async () => {
        mockPrisma.userTenantRole.findUnique.mockResolvedValue({ roleId: 'r1', role: 'Owner', customRole: { id: 'r1', name: 'Owner', level: 5 } });
        const identity = { userId: 'u1', email: 'a@b.co', tenantId: freshTenantId(), roleName: null, isSuperAdmin: false };

        const first = await buildPrincipalFor(identity);
        const second = await buildPrincipalFor(identity);

        expect(second).toBe(first);
        expect(mockPrisma.userTenantRole.findUnique).toHaveBeenCalledTimes(1);
    });

    it('re-queries when the RBAC version changes', async () => {
        mockPrisma.userTenantRole.findUnique.mockResolvedValue({ roleId: 'r1', role: 'Owner', customRole: { id: 'r1', name: 'Owner', level: 5 } });
        const identity = { userId: 'u1', email: 'a@b.co', tenantId: freshTenantId(), roleName: null, isSuperAdmin: false };

        vi.mocked(getRbacVersion).mockResolvedValue(1);
        await buildPrincipalFor(identity);
        vi.mocked(getRbacVersion).mockResolvedValue(2);
        await buildPrincipalFor(identity);

        expect(mockPrisma.userTenantRole.findUnique).toHaveBeenCalledTimes(2);
    });
});
