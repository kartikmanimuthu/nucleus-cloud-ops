/**
 * The property that matters most here is a NEGATIVE one: syncing from the legacy
 * blob must never destroy rules the blob cannot express. A Record<Module,
 * Action[]> has no way to say "subject-level" or "cannot", so a naive full sync
 * would silently delete finer-grained authorisation every time someone toggled
 * an unrelated checkbox in the roles screen.
 */

import { describe, expect, it, vi } from 'vitest';

import { syncRoleRules } from './role-rule-sync';
import type { PermissionSet } from './types';

const MODULES = [
    { id: 'm-accounts', key: 'Accounts', tenantId: null },
    { id: 'm-schedules', key: 'Schedules', tenantId: null },
    { id: 'm-settings', key: 'Settings', tenantId: null },
    { id: 'm-dashboard', key: 'Dashboard', tenantId: null },
];

const ACTIONS = [
    { id: 'a-create', key: 'create', tenantId: null },
    { id: 'a-read', key: 'read', tenantId: null },
    { id: 'a-update', key: 'update', tenantId: null },
    { id: 'a-delete', key: 'delete', tenantId: null },
];

interface ExistingRule {
    id: string;
    moduleId: string | null;
    actionId: string;
    subjectId?: string | null;
    inverted?: boolean;
}

function fakeTx(existing: ExistingRule[] = [], overrides: { modules?: typeof MODULES } = {}) {
    // Argument types are declared so `.mock.calls[0][0]` is indexable. A bare
    // vi.fn() infers a zero-length tuple, which makes every assertion below a
    // type error even though the calls are real.
    interface CreateManyArgs { data: { roleId: string; tenantId: string | null; actionId: string; moduleId: string }[] }
    interface DeleteManyArgs { where: { id: { in: string[] } } }
    const createMany = vi.fn(async (_args: CreateManyArgs) => ({ count: 0 }));
    const deleteMany = vi.fn(async (_args: DeleteManyArgs) => ({ count: 0 }));
    const findMany = vi.fn(async (args: { where: Record<string, unknown> }) => {
        // Mirror the real query: module-level POSITIVE grants only.
        const w = args.where as { subjectId?: null; inverted?: boolean };
        return existing.filter(
            (r) => (r.subjectId ?? null) === (w.subjectId ?? null) && (r.inverted ?? false) === (w.inverted ?? false)
        );
    });

    return {
        tx: {
            rbacModule: { findMany: async () => overrides.modules ?? MODULES },
            rbacAction: { findMany: async () => ACTIONS },
            rbacRoleRule: { findMany, createMany, deleteMany },
        },
        createMany,
        deleteMany,
    };
}

const base = { roleId: 'role-1', tenantId: 't1', createdBy: 'tester@example.com' };

describe('syncRoleRules', () => {
    it('creates a rule per (module, action) in the blob', async () => {
        const { tx, createMany } = fakeTx();

        const result = await syncRoleRules(tx as never, {
            ...base,
            permissions: { Accounts: ['read', 'create'] } as PermissionSet,
        });

        expect(result.created).toBe(2);
        expect(result.deleted).toBe(0);
        const rows = createMany.mock.calls[0][0].data;
        expect(rows).toHaveLength(2);
        expect(rows.every((r) => r.roleId === 'role-1' && r.tenantId === 't1')).toBe(true);
    });

    it('deletes a grant that was removed from the blob', async () => {
        // Role currently has Accounts:read and Accounts:delete; blob keeps only read.
        const { tx, deleteMany } = fakeTx([
            { id: 'r-keep', moduleId: 'm-accounts', actionId: 'a-read' },
            { id: 'r-drop', moduleId: 'm-accounts', actionId: 'a-delete' },
        ]);

        const result = await syncRoleRules(tx as never, {
            ...base,
            permissions: { Accounts: ['read'] } as PermissionSet,
        });

        expect(result.deleted).toBe(1);
        expect(deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['r-drop'] } } });
    });

    it('is idempotent — an unchanged blob writes nothing', async () => {
        const { tx, createMany, deleteMany } = fakeTx([
            { id: 'r1', moduleId: 'm-accounts', actionId: 'a-read' },
        ]);

        const result = await syncRoleRules(tx as never, {
            ...base,
            permissions: { Accounts: ['read'] } as PermissionSet,
        });

        expect(result).toMatchObject({ created: 0, deleted: 0 });
        expect(createMany).not.toHaveBeenCalled();
        expect(deleteMany).not.toHaveBeenCalled();
    });

    // ── the load-bearing negative property ───────────────────────────────────
    it('never deletes subject-level or inverted rules', async () => {
        const { tx, deleteMany } = fakeTx([
            { id: 'r-module', moduleId: 'm-accounts', actionId: 'a-delete' },
            // These two are invisible to the blob and must survive.
            { id: 'r-subject', moduleId: null, actionId: 'a-delete', subjectId: 's-account' },
            { id: 'r-cannot', moduleId: 'm-accounts', actionId: 'a-delete', inverted: true },
        ]);

        await syncRoleRules(tx as never, {
            ...base,
            permissions: { Accounts: ['read'] } as PermissionSet,
        });

        const deletedIds = deleteMany.mock.calls[0]?.[0]?.where.id.in ?? [];
        expect(deletedIds).toEqual(['r-module']);
        expect(deletedIds).not.toContain('r-subject');
        expect(deletedIds).not.toContain('r-cannot');
    });

    it('expands the `manage` alias into its four CRUD rules', async () => {
        const { tx, createMany } = fakeTx();

        const result = await syncRoleRules(tx as never, {
            ...base,
            permissions: { Schedules: ['manage'] } as unknown as PermissionSet,
        });

        expect(result.created).toBe(4);
        const actionIds = createMany.mock.calls[0][0].data.map((r) => r.actionId).sort();
        expect(actionIds).toEqual(['a-create', 'a-delete', 'a-read', 'a-update']);
    });

    it('resolves aliased verbs to their terminal action', async () => {
        const { tx, createMany } = fakeTx();

        // execute -> update, per ACTION_MAP and authorize()'s read-time resolution.
        await syncRoleRules(tx as never, {
            ...base,
            permissions: { Schedules: ['execute'] } as unknown as PermissionSet,
        });

        expect(createMany.mock.calls[0][0].data[0].actionId).toBe('a-update');
    });

    it('reports an unknown module instead of guessing', async () => {
        const { tx, createMany } = fakeTx();

        const result = await syncRoleRules(tx as never, {
            ...base,
            permissions: { Nonexistent: ['read'] } as unknown as PermissionSet,
        });

        expect(result.created).toBe(0);
        expect(result.skipped).toContain("module 'Nonexistent'");
        expect(createMany).not.toHaveBeenCalled();
    });

    it('clears every grant when the blob is emptied', async () => {
        const { tx, deleteMany } = fakeTx([
            { id: 'r1', moduleId: 'm-accounts', actionId: 'a-read' },
            { id: 'r2', moduleId: 'm-schedules', actionId: 'a-read' },
        ]);

        const result = await syncRoleRules(tx as never, { ...base, permissions: {} as PermissionSet });

        expect(result.deleted).toBe(2);
        expect(deleteMany).toHaveBeenCalled();
    });

    it('prefers a tenant module override over the global row of the same key', async () => {
        const { tx, createMany } = fakeTx([], {
            modules: [
                { id: 'm-global', key: 'Accounts', tenantId: null },
                { id: 'm-tenant', key: 'Accounts', tenantId: 't1' },
            ] as typeof MODULES,
        });

        await syncRoleRules(tx as never, {
            ...base,
            permissions: { Accounts: ['read'] } as PermissionSet,
        });

        // Deliberately fed global-first, which is the order Postgres actually
        // returns under `ORDER BY tenantId DESC` (NULLS FIRST). Resolution must
        // not depend on row order.
        expect(createMany.mock.calls[0][0].data[0].moduleId).toBe('m-tenant');
    });
});
