/**
 * The property that matters most is the same NEGATIVE one role-rule-sync.test.ts
 * protects, narrowed by one level: this editor owns subject rules that carry
 * NEITHER conditions NOR a field list. A subject rule with conditions is the
 * ABAC layer and must survive a save from a UI that cannot display it.
 */

import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

import { syncRoleSubjectOverrides } from './role-subject-overrides';

const SUBJECTS = [
    { id: 's-provider', key: 'Provider', tenantId: null },
    { id: 's-skill', key: 'Skill', tenantId: null },
];

const ACTIONS = [
    { id: 'a-create', key: 'create', tenantId: null },
    { id: 'a-read', key: 'read', tenantId: null },
    { id: 'a-update', key: 'update', tenantId: null },
    { id: 'a-delete', key: 'delete', tenantId: null },
];

interface ExistingRule {
    id: string;
    subjectId: string | null;
    actionId: string;
    inverted: boolean;
    /** Row's owning role. Defaults to 'role-1', the role every test in this
     * file syncs against, so existing call sites don't need to name it. */
    roleId?: string;
    /** Defaults to the sentinel the real "editor-owned" query requires. */
    conditions?: unknown;
    fields?: unknown[];
    /** Row's owning tenant. Defaults to null — a global preset row — since a
     * shared preset roleId is exactly the scenario the cross-tenant test below
     * exercises; most other tests don't care and rely on this default. */
    tenantId?: string | null;
}

function fakeTx(existing: ExistingRule[] = [], overrides: { subjects?: typeof SUBJECTS; actions?: typeof ACTIONS } = {}) {
    interface CreateManyArgs {
        data: { roleId: string; tenantId: string | null; actionId: string; subjectId: string; inverted: boolean }[];
    }
    interface DeleteManyArgs { where: { id: { in: string[] } } }
    const createMany = vi.fn(async (_args: CreateManyArgs) => ({ count: 0 }));
    const deleteMany = vi.fn(async (_args: DeleteManyArgs) => ({ count: 0 }));

    // Fill in the "editor-owned" defaults so existing call sites (which only
    // name id/subjectId/actionId/inverted) still describe rows the real query
    // would actually return.
    const rows = existing.map((r) => ({
        roleId: 'role-1',
        conditions: Prisma.DbNull,
        fields: [] as unknown[],
        tenantId: null as string | null,
        ...r,
    }));

    // Mirrors the real query's WHERE clause, including the parts that are
    // easy to accidentally drop: filtering by roleId (so one role's save
    // can't reconcile-and-delete another role's rows), requiring the
    // Prisma.DbNull / empty-fields sentinel (so ABAC-owned rows aren't
    // mistaken for editor-owned ones), and the tenant scope — a bare
    // `tenantId` equality, or the `OR: [{ tenantId }, { tenantId: null }]`
    // shape the real scope produces — so a shared preset roleId's rows from
    // ANOTHER tenant don't leak into this tenant's reconcile. Any clause key
    // the caller omits is simply not filtered on — matching what a dropped
    // WHERE fragment would actually do against Postgres.
    const findMany = vi.fn(async (args: { where: Record<string, unknown> }) => {
        const w = args.where;
        return rows.filter((r) => {
            if ('roleId' in w && r.roleId !== w.roleId) return false;
            if ('subjectId' in w) {
                const subjectClause = w.subjectId as { not?: null } | undefined;
                if (subjectClause && 'not' in subjectClause && r.subjectId === subjectClause.not) return false;
            }
            if ('conditions' in w) {
                const conditionsClause = w.conditions as { equals?: unknown } | undefined;
                if (conditionsClause && r.conditions !== conditionsClause.equals) return false;
            }
            if ('fields' in w) {
                const fieldsClause = w.fields as { equals?: unknown[] } | undefined;
                if (fieldsClause && JSON.stringify(r.fields) !== JSON.stringify(fieldsClause.equals)) return false;
            }
            if ('tenantId' in w && r.tenantId !== w.tenantId) return false;
            if ('OR' in w) {
                const branches = w.OR as { tenantId?: string | null }[];
                if (!branches.some((b) => r.tenantId === b.tenantId)) return false;
            }
            return true;
        });
    });

    return {
        tx: {
            rbacSubject: { findMany: async () => overrides.subjects ?? SUBJECTS },
            rbacAction: { findMany: async () => overrides.actions ?? ACTIONS },
            rbacRoleRule: { findMany, createMany, deleteMany },
        },
        createMany,
        deleteMany,
        findMany,
    };
}

const base = { roleId: 'role-1', tenantId: 't1', createdBy: 'tester@example.com' };

describe('syncRoleSubjectOverrides', () => {
    it('creates a positive rule for a grant', async () => {
        const { tx, createMany } = fakeTx();

        const result = await syncRoleSubjectOverrides(tx as never, {
            ...base,
            overrides: { Provider: { grant: ['read'], deny: [] } },
        });

        expect(result.created).toBe(1);
        expect(createMany.mock.calls[0][0].data).toEqual([
            { roleId: 'role-1', tenantId: 't1', subjectId: 's-provider', actionId: 'a-read', inverted: false, createdBy: 'tester@example.com' },
        ]);
    });

    it('creates an inverted rule for a deny', async () => {
        const { tx, createMany } = fakeTx();

        await syncRoleSubjectOverrides(tx as never, {
            ...base,
            overrides: { Provider: { grant: [], deny: ['update'] } },
        });

        expect(createMany.mock.calls[0][0].data[0]).toMatchObject({ subjectId: 's-provider', actionId: 'a-update', inverted: true });
    });

    it('deletes an override the payload no longer contains', async () => {
        const { tx, deleteMany } = fakeTx([
            { id: 'rule-old', subjectId: 's-skill', actionId: 'a-delete', inverted: true },
        ]);

        const result = await syncRoleSubjectOverrides(tx as never, { ...base, overrides: {} });

        expect(result.deleted).toBe(1);
        expect(deleteMany.mock.calls[0][0].where.id.in).toEqual(['rule-old']);
    });

    it('leaves an unchanged override alone', async () => {
        const { tx, createMany, deleteMany } = fakeTx([
            { id: 'rule-keep', subjectId: 's-provider', actionId: 'a-read', inverted: false },
        ]);

        const result = await syncRoleSubjectOverrides(tx as never, {
            ...base,
            overrides: { Provider: { grant: ['read'], deny: [] } },
        });

        expect(result).toMatchObject({ created: 0, deleted: 0 });
        expect(createMany).not.toHaveBeenCalled();
        expect(deleteMany).not.toHaveBeenCalled();
    });

    it('scopes its read to rules with no conditions and no fields', async () => {
        const { tx, findMany } = fakeTx();

        await syncRoleSubjectOverrides(tx as never, { ...base, overrides: {} });

        const where = findMany.mock.calls[0][0].where;
        expect(where.subjectId).toEqual({ not: null });
        expect(where.fields).toEqual({ equals: [] });
        // Prisma.DbNull, never a bare null — a bare null means "the JSON value
        // null" on a nullable Json column and matches zero rows. toBeDefined()
        // would pass on { equals: null } too, which is exactly the regression
        // this test exists to catch, so assert the actual sentinel.
        expect(where.conditions).toEqual({ equals: Prisma.DbNull });
    });

    it('resolves aliased verbs to terminal actions', async () => {
        const { tx, createMany } = fakeTx();

        await syncRoleSubjectOverrides(tx as never, {
            ...base,
            overrides: { Provider: { grant: [], deny: ['execute'] } },
        });

        // execute -> update, matching how authorize() resolves at read time.
        expect(createMany.mock.calls[0][0].data[0]).toMatchObject({ actionId: 'a-update', inverted: true });
    });

    it('reports an unknown subject rather than guessing', async () => {
        const { tx, createMany } = fakeTx();

        const result = await syncRoleSubjectOverrides(tx as never, {
            ...base,
            overrides: { GhostSubject: { grant: ['read'], deny: [] } },
        });

        expect(result.skipped).toEqual([`subject 'GhostSubject'`]);
        expect(createMany).not.toHaveBeenCalled();
    });

    it('lets deny win when a verb appears in both lists', async () => {
        const { tx, createMany } = fakeTx();

        await syncRoleSubjectOverrides(tx as never, {
            ...base,
            overrides: { Provider: { grant: ['read'], deny: ['read'] } },
        });

        const data = createMany.mock.calls[0][0].data;
        expect(data).toHaveLength(1);
        expect(data[0]).toMatchObject({ actionId: 'a-read', inverted: true });
    });

    // ── the load-bearing negative property for cross-role isolation ─────────
    it('scopes deletions to the target role only', async () => {
        const { tx, deleteMany } = fakeTx([
            { id: 'rule-mine', subjectId: 's-provider', actionId: 'a-read', inverted: false, roleId: 'role-1' },
            // A different role's editor-owned row, on a different (subject,
            // action) key so it can't be masked by the reconciler's own
            // subject::action dedup. If `roleId` is ever dropped from the
            // implementation's WHERE clause, this row leaks into role-1's
            // sync and gets deleted alongside it.
            { id: 'rule-other-role', subjectId: 's-skill', actionId: 'a-delete', inverted: true, roleId: 'role-2' },
        ]);

        await syncRoleSubjectOverrides(tx as never, { ...base, overrides: {} });

        const deletedIds = deleteMany.mock.calls[0][0].where.id.in;
        expect(deletedIds).toEqual(['rule-mine']);
        expect(deletedIds).not.toContain('rule-other-role');
    });

    it('expands the `manage` alias into its four CRUD rules', async () => {
        const { tx, createMany } = fakeTx();

        const result = await syncRoleSubjectOverrides(tx as never, {
            ...base,
            overrides: { Provider: { grant: ['manage'], deny: [] } },
        });

        expect(result.created).toBe(4);
        const rows = createMany.mock.calls[0][0].data;
        expect(rows.every((r) => r.subjectId === 's-provider')).toBe(true);
        const actionIds = rows.map((r) => r.actionId).sort();
        expect(actionIds).toEqual(['a-create', 'a-delete', 'a-read', 'a-update']);
    });

    it('prefers a tenant subject override over the global row of the same key', async () => {
        const { tx, createMany } = fakeTx([], {
            subjects: [
                { id: 's-global', key: 'Provider', tenantId: null },
                { id: 's-tenant', key: 'Provider', tenantId: 't1' },
            ] as typeof SUBJECTS,
        });

        await syncRoleSubjectOverrides(tx as never, {
            ...base,
            overrides: { Provider: { grant: ['read'], deny: [] } },
        });

        // Deliberately fed global-first, which is the order Postgres actually
        // returns under `ORDER BY tenantId DESC` (NULLS FIRST). Resolution
        // must not depend on row order — indexByKey exists specifically to
        // survive this.
        expect(createMany.mock.calls[0][0].data[0].subjectId).toBe('s-tenant');
    });

    // ── the load-bearing negative property for cross-TENANT isolation ───────
    // A preset role's `id` is shared by every tenant, but each tenant's
    // rbac_role_rules rows carry their own tenantId. Without a tenant scope on
    // the "existing rows" read, tenant B's save of that shared roleId pulls in
    // tenant A's rows too, and this reconciler's diff logic then DELETES them
    // for being "not in B's desired set" — cross-tenant data destruction, not
    // just a display bug.
    it('does not touch another tenant\'s rows on a shared (preset) roleId', async () => {
        const { tx, createMany, deleteMany } = fakeTx([
            // Tenant A's own grant, on a key tenant B's save never mentions.
            // Unscoped, this looks like "not in B's desired set" and gets deleted.
            { id: 'rule-tenant-a-unrelated', subjectId: 's-skill', actionId: 'a-delete', inverted: true, tenantId: 'tenant-a' },
            // Tenant A's grant on the SAME (subject, action) tenant B is about to
            // request. Unscoped, this row satisfies B's desired state by
            // accident — B's own row is never created, so B silently has no
            // grant of its own while believing the sync succeeded.
            { id: 'rule-tenant-a-shared-key', subjectId: 's-provider', actionId: 'a-read', inverted: false, tenantId: 'tenant-a' },
        ]);

        const result = await syncRoleSubjectOverrides(tx as never, {
            ...base, // tenantId: 't1'
            overrides: { Provider: { grant: ['read'], deny: [] } },
        });

        // Tenant A's unrelated row must survive — never deleted for tenant B's save.
        const deletedIds = deleteMany.mock.calls[0]?.[0]?.where.id.in ?? [];
        expect(deletedIds).not.toContain('rule-tenant-a-unrelated');
        expect(deletedIds).not.toContain('rule-tenant-a-shared-key');

        // Tenant B must get its OWN row created — tenant A's row on the same
        // key must not be mistaken for B's already-satisfied state.
        expect(result.created).toBe(1);
        expect(createMany).toHaveBeenCalled();
        const created = createMany.mock.calls[0][0].data[0];
        expect(created).toMatchObject({ tenantId: 't1', subjectId: 's-provider', actionId: 'a-read', inverted: false });
    });
});
