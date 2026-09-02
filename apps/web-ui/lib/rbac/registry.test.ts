/**
 * loadRegistrySnapshot's subjectModules merge (Finding C2, task-4 fix round).
 *
 * Every other snapshot list (modules/actions/subjects) already shadows global
 * rows via mergeByKey; subjectModules was passed through RAW. A tenant remap
 * therefore left the global link standing alongside the new tenant-local one,
 * and rule-compiler.ts — which has no orderBy on either fetch and no
 * deduplication of its own — bucketed the subject under BOTH modules.
 */
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
    prisma: {
        rbacModule: { findMany: vi.fn().mockResolvedValue([]) },
        rbacAction: { findMany: vi.fn().mockResolvedValue([]) },
        rbacSubject: { findMany: vi.fn().mockResolvedValue([]) },
        rbacSubjectModule: { findMany: vi.fn() },
        rbacModuleAction: { findMany: vi.fn().mockResolvedValue([]) },
        rbacSubjectAttribute: { findMany: vi.fn().mockResolvedValue([]) },
        rbacPrincipalAttribute: { findMany: vi.fn().mockResolvedValue([]) },
        rbacRoutePermission: { findMany: vi.fn().mockResolvedValue([]) },
        rbacRoleRule: { findMany: vi.fn().mockResolvedValue([]) },
        customRole: { findFirst: vi.fn().mockResolvedValue(null) },
        rbacGlobalVersion: { findUnique: vi.fn().mockResolvedValue(null) },
        tenant: { findUnique: vi.fn().mockResolvedValue(null) },
    },
}));
vi.mock('@/lib/db/pg-config', () => ({ getPrismaClient: () => h.prisma }));

import {
    loadRegistrySnapshot, loadAssignablePrincipalAttributes, loadRoutePermissions, loadRoleRules,
    resolveRoleIdByName, loadGlobalSubjectCoverageRows, readRbacVersion,
} from './registry';

describe('loadRegistrySnapshot — subjectModules merge', () => {
    it('lets a tenant-local subject-module link shadow the global link for the same subject', async () => {
        h.prisma.rbacSubjectModule.findMany.mockResolvedValue([
            { tenantId: null, subjectId: 's-spotguard', moduleId: 'm-sched' },
            { tenantId: 't1', subjectId: 's-spotguard', moduleId: 'm-cost' },
        ]);
        const snapshot = await loadRegistrySnapshot('t1');
        expect(snapshot.subjectModules).toHaveLength(1);
        expect(snapshot.subjectModules[0]).toEqual({ tenantId: 't1', subjectId: 's-spotguard', moduleId: 'm-cost' });
    });

    it('keeps the global link when no tenant override exists', async () => {
        h.prisma.rbacSubjectModule.findMany.mockResolvedValue([
            { tenantId: null, subjectId: 's-acc', moduleId: 'm-acc' },
        ]);
        const snapshot = await loadRegistrySnapshot('t1');
        expect(snapshot.subjectModules).toEqual([{ tenantId: null, subjectId: 's-acc', moduleId: 'm-acc' }]);
    });

    it('is order-independent — the tenant link wins whichever row the query returns first', async () => {
        h.prisma.rbacSubjectModule.findMany.mockResolvedValue([
            { tenantId: 't1', subjectId: 's-spotguard', moduleId: 'm-cost' },
            { tenantId: null, subjectId: 's-spotguard', moduleId: 'm-sched' },
        ]);
        const snapshot = await loadRegistrySnapshot('t1');
        expect(snapshot.subjectModules).toEqual([{ tenantId: 't1', subjectId: 's-spotguard', moduleId: 'm-cost' }]);
    });

    it('keeps unrelated subjects as separate entries', async () => {
        h.prisma.rbacSubjectModule.findMany.mockResolvedValue([
            { tenantId: null, subjectId: 's-spotguard', moduleId: 'm-sched' },
            { tenantId: null, subjectId: 's-acc', moduleId: 'm-acc' },
        ]);
        const snapshot = await loadRegistrySnapshot('t1');
        expect(snapshot.subjectModules).toHaveLength(2);
    });

    it('scopes every one of the seven parallel queries to global-or-this-tenant rows', async () => {
        h.prisma.rbacSubjectModule.findMany.mockResolvedValue([]);
        await loadRegistrySnapshot('t1');

        const scope = { OR: [{ tenantId: 't1' }, { tenantId: null }] };
        expect(h.prisma.rbacModule.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: scope }));
        expect(h.prisma.rbacAction.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: scope }));
        expect(h.prisma.rbacSubject.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: scope }));
        expect(h.prisma.rbacSubjectModule.findMany).toHaveBeenCalledWith({ where: scope });
        expect(h.prisma.rbacModuleAction.findMany).toHaveBeenCalledWith({ where: scope });
        expect(h.prisma.rbacSubjectAttribute.findMany).toHaveBeenCalledWith({ where: scope });
        expect(h.prisma.rbacPrincipalAttribute.findMany).toHaveBeenCalledWith({ where: scope });
    });

    it('lets a tenant-local module/action/subject shadow the global row of the same key (mergeByKey)', async () => {
        h.prisma.rbacModule.findMany.mockResolvedValue([
            { key: 'inventory', tenantId: null, sortOrder: 1 },
            { key: 'inventory', tenantId: 't1', sortOrder: 1 },
        ]);
        h.prisma.rbacSubjectModule.findMany.mockResolvedValue([]);
        const snapshot = await loadRegistrySnapshot('t1');
        expect(snapshot.modules).toEqual([{ key: 'inventory', tenantId: 't1', sortOrder: 1 }]);
    });

    it('mergeByKey keeps an already-seen tenant row when a global row for the same key arrives later', async () => {
        h.prisma.rbacModule.findMany.mockResolvedValue([
            { key: 'inventory', tenantId: 't1', sortOrder: 1 },
            { key: 'inventory', tenantId: null, sortOrder: 1 },
        ]);
        h.prisma.rbacSubjectModule.findMany.mockResolvedValue([]);
        const snapshot = await loadRegistrySnapshot('t1');
        expect(snapshot.modules).toEqual([{ key: 'inventory', tenantId: 't1', sortOrder: 1 }]);
    });

    it('moduleActions/subjectAttributes/principalAttributes pass through unmerged', async () => {
        h.prisma.rbacModuleAction.findMany.mockResolvedValue([{ moduleId: 'm1', actionId: 'a1', tenantId: null }]);
        h.prisma.rbacSubjectModule.findMany.mockResolvedValue([]);
        const snapshot = await loadRegistrySnapshot('t1');
        expect(snapshot.moduleActions).toEqual([{ moduleId: 'm1', actionId: 'a1', tenantId: null }]);
        expect(snapshot.tenantId).toBe('t1');
    });
});

describe('loadAssignablePrincipalAttributes', () => {
    it('scopes to global-or-tenant AND source="user", excluding session-derived builtins', async () => {
        await loadAssignablePrincipalAttributes('t1');
        expect(h.prisma.rbacPrincipalAttribute.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { source: 'user', OR: [{ tenantId: 't1' }, { tenantId: null }] } }),
        );
    });
});

describe('loadRoutePermissions', () => {
    it('orders by sortOrder then id, scoped to global-or-tenant', async () => {
        await loadRoutePermissions('t1');
        expect(h.prisma.rbacRoutePermission.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { OR: [{ tenantId: 't1' }, { tenantId: null }] },
                orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
            }),
        );
    });
});

describe('loadRoleRules', () => {
    it('scopes to the given roleId AND global-or-tenant', async () => {
        await loadRoleRules('t1', 'role-1');
        expect(h.prisma.rbacRoleRule.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { roleId: 'role-1', OR: [{ tenantId: 't1' }, { tenantId: null }] } }),
        );
    });
});

describe('resolveRoleIdByName', () => {
    it('looks up a tenant-custom role OR a global preset with the same name, preferring custom', async () => {
        h.prisma.customRole.findFirst.mockResolvedValue({ id: 'role-custom' });
        const id = await resolveRoleIdByName('t1', 'Admin');

        expect(h.prisma.customRole.findFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: { OR: [{ tenantId: 't1', name: 'Admin', type: 'custom' }, { tenantId: null, name: 'Admin', type: 'preset' }] },
            orderBy: { type: 'asc' },
        }));
        expect(id).toBe('role-custom');
    });

    it('returns null when neither a custom nor a preset role matches', async () => {
        h.prisma.customRole.findFirst.mockResolvedValue(null);
        expect(await resolveRoleIdByName('t1', 'Nonexistent')).toBeNull();
    });
});

describe('loadGlobalSubjectCoverageRows', () => {
    it('reads only tenantId:null rows, unmerged with any tenant override', async () => {
        h.prisma.rbacSubject.findMany.mockResolvedValue([{ key: 's1', tenantId: null }]);
        h.prisma.rbacSubjectModule.findMany.mockResolvedValue([{ subjectId: 's1', tenantId: null }]);
        h.prisma.rbacModule.findMany.mockResolvedValue([{ key: 'm1', tenantId: null }]);

        const result = await loadGlobalSubjectCoverageRows();

        expect(h.prisma.rbacSubject.findMany).toHaveBeenCalledWith({ where: { tenantId: null } });
        expect(h.prisma.rbacSubjectModule.findMany).toHaveBeenCalledWith({ where: { tenantId: null } });
        expect(h.prisma.rbacModule.findMany).toHaveBeenCalledWith({ where: { tenantId: null } });
        expect(result).toEqual({
            subjects: [{ key: 's1', tenantId: null }],
            subjectModules: [{ subjectId: 's1', tenantId: null }],
            modules: [{ key: 'm1', tenantId: null }],
        });
    });
});

describe('readRbacVersion', () => {
    it('combines global and tenant version numbers with a dot', async () => {
        h.prisma.rbacGlobalVersion.findUnique.mockResolvedValue({ version: 7 });
        h.prisma.tenant.findUnique.mockResolvedValue({ rbacVersion: 3 });
        expect(await readRbacVersion('t1')).toBe('7.3');
    });

    it('defaults both halves to 0 when the rows do not exist yet', async () => {
        h.prisma.rbacGlobalVersion.findUnique.mockResolvedValue(null);
        h.prisma.tenant.findUnique.mockResolvedValue(null);
        expect(await readRbacVersion('t1')).toBe('0.0');
    });
});
