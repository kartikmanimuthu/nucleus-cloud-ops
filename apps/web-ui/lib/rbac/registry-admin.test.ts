/**
 * The admin registry read is what the Modules and Permissions screens render
 * from, and what makes a delete refusal truthful. Two properties matter: a
 * tenant-local row must shadow the global row of the same key (same precedence
 * as registry.ts's mergeByKey), and a row's ruleCount must be the number of
 * grants that would be destroyed by deleting it.
 *
 * Write-path tests (createAction/updateAction/deleteAction, createModule/
 * updateModule/deleteModule) live in registry-admin-writes.test.ts, next to
 * the write functions themselves.
 */
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
    prisma: {
        rbacModule: { findMany: vi.fn() },
        rbacAction: { findMany: vi.fn() },
        rbacSubject: { findMany: vi.fn() },
        rbacSubjectModule: { findMany: vi.fn() },
        rbacModuleAction: { findMany: vi.fn() },
        rbacRoleRule: { groupBy: vi.fn() },
    },
}));
vi.mock('@/lib/db/pg-config', () => ({ getPrismaClient: () => h.prisma }));

import { loadAdminRegistry } from './registry-admin';

function seed() {
    h.prisma.rbacModule.findMany.mockResolvedValue([
        { id: 'm-acc', tenantId: null, key: 'Accounts', label: 'Accounts', description: null, icon: null, navPath: '/app/accounts', sortOrder: 10, enabled: true, isSystem: true },
        { id: 'm-acc-t', tenantId: 't1', key: 'Accounts', label: 'AWS Accounts', description: null, icon: null, navPath: '/app/accounts', sortOrder: 10, enabled: true, isSystem: false },
    ]);
    h.prisma.rbacAction.findMany.mockResolvedValue([
        { id: 'a-read', tenantId: null, key: 'read', label: 'Read', description: null, aliasOfKey: null, isDangerous: false, sortOrder: 20, isSystem: true },
    ]);
    h.prisma.rbacSubject.findMany.mockResolvedValue([
        { id: 's-acc', tenantId: null, key: 'Account', label: 'AWS Account', kind: 'resource', isSystem: true },
    ]);
    h.prisma.rbacSubjectModule.findMany.mockResolvedValue([{ subjectId: 's-acc', moduleId: 'm-acc' }]);
    h.prisma.rbacModuleAction.findMany.mockResolvedValue([
        { moduleId: 'm-acc', actionId: 'a-read', grantable: true },
        { moduleId: 'm-acc', actionId: 'a-read', grantable: false },
    ]);
    h.prisma.rbacRoleRule.groupBy.mockResolvedValue([]);
}

describe('loadAdminRegistry', () => {
    it('lets a tenant-local row shadow the global row of the same key', async () => {
        seed();
        const registry = await loadAdminRegistry('t1');
        expect(registry.modules).toHaveLength(1);
        expect(registry.modules[0].label).toBe('AWS Accounts');
        expect(registry.modules[0].isGlobal).toBe(false);
    });

    it('counts only grantable cells toward grantableCellCount', async () => {
        seed();
        const registry = await loadAdminRegistry('t1');
        expect(registry.grantableCellCount).toBe(1);
    });

    it('reports the rules that a delete would destroy', async () => {
        seed();
        h.prisma.rbacRoleRule.groupBy.mockResolvedValue([
            { moduleId: 'm-acc-t', actionId: 'a-read', _count: { _all: 3 } },
        ]);
        const registry = await loadAdminRegistry('t1');
        expect(registry.modules[0].ruleCount).toBe(3);
        expect(registry.actions[0].ruleCount).toBe(3);
    });

    // The case above plants the rule on 'm-acc-t', which is ALSO the winning
    // module's own id — an id-keyed implementation gets this right by accident.
    // The global preset roles' rules point at the global module id, which is
    // never deleted when a tenant overrides it, so the real invariant is that a
    // rule on the SHADOWED id ('m-acc') must still land on the merged row.
    it('counts a rule pointing at the shadowed global id toward the merged row', async () => {
        seed();
        h.prisma.rbacRoleRule.groupBy.mockResolvedValue([
            { moduleId: 'm-acc', actionId: 'a-read', _count: { _all: 7 } },
        ]);
        const registry = await loadAdminRegistry('t1');
        expect(registry.modules[0].ruleCount).toBe(7);
        expect(registry.actions[0].ruleCount).toBe(7);
    });

    // seed()'s rbacModuleAction rows deliberately point at 'm-acc' (the shadowed
    // global id), not 'm-acc-t' (the merged/winning id) — matching how a real
    // tenant override leaves the global links in place. The grid's columns must
    // still resolve to the merged module.
    it('resolves grantable cells linked to the shadowed global module id', async () => {
        seed();
        const registry = await loadAdminRegistry('t1');
        expect(registry.modules[0].actionKeys).toEqual(['read']);
    });

    // Same shadowed-id shape for the subject/module mapping: seed()'s
    // rbacSubjectModule row points at 'm-acc', and both directions of that
    // mapping must resolve to the merged module's key.
    it('resolves a subject-module link pointing at the shadowed global module id', async () => {
        seed();
        const registry = await loadAdminRegistry('t1');
        expect(registry.modules[0].subjectKeys).toEqual(['Account']);
        expect(registry.subjects[0].moduleKey).toBe('Accounts');
    });

    /**
     * A remap writes a tenant-local link and leaves the global one standing — it
     * must, since mutating the global row would move the subject for every
     * tenant. Both match this reader's scope, so without merging by subjectId
     * the subject appears in BOTH modules' subjectKeys and its `moduleKey`
     * resolves to whichever link the unordered query happened to return last.
     * On the Modules screen that reads as a subject listed twice and an
     * arbitrary owner. registry.ts applies the same merge for the compiler.
     */
    it('lets a tenant-local subject-module link shadow the global one', async () => {
        seed();
        h.prisma.rbacModule.findMany.mockResolvedValue([
            { id: 'm-acc', tenantId: null, key: 'Accounts', label: 'Accounts', description: null, icon: null, navPath: null, sortOrder: 10, enabled: true, isSystem: true },
            { id: 'm-cost', tenantId: 't1', key: 'CostControl', label: 'Cost Control', description: null, icon: null, navPath: null, sortOrder: 70, enabled: true, isSystem: false },
        ]);
        h.prisma.rbacSubjectModule.findMany.mockResolvedValue([
            { tenantId: null, subjectId: 's-acc', moduleId: 'm-acc' },
            { tenantId: 't1', subjectId: 's-acc', moduleId: 'm-cost' },
        ]);

        const registry = await loadAdminRegistry('t1');

        expect(registry.subjects[0].moduleKey).toBe('CostControl');
        expect(registry.modules.find((m) => m.key === 'Accounts')?.subjectKeys).toEqual([]);
        expect(registry.modules.find((m) => m.key === 'CostControl')?.subjectKeys).toEqual(['Account']);
    });
});
