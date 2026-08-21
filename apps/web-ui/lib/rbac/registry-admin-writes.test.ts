/**
 * Registry WRITES for verbs and modules — the write half split out of
 * registry-admin.ts (see registry-admin.test.ts for the read side).
 *
 * Two silent-revocation traps are covered here:
 *   - un-ticking a grantable cell that still has live grants (grantable=false
 *     does not stop an existing rule compiling — rule-compiler.ts:244-251);
 *   - moving a subject between modules (a module rule expands over the
 *     module's CURRENT subjects at compile time, so a remap can evaporate a
 *     grant with no rule edited — see the comment on RbacSubjectModule).
 *
 * 'a-read' is deliberately never the id the registry resolves for the 'read'
 * key in the module fixtures below (see seedModulesForWrites) — it stands in
 * for a cell the module used to grant that is no longer in the desired
 * actionKeys, so every updateModule call here exercises the removal path,
 * gated by h.tx.rbacRoleRule.count.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
    const tx = {
        rbacRuleChangeLog: { create: vi.fn() },
        rbacGlobalVersion: { update: vi.fn() },
        tenant: { update: vi.fn() },
        // The lockout invariant (D-13) runs inside every tenant-scoped mutation, so
        // the stub must satisfy it. Defaults describe a healthy tenant — one
        // unconditional admin grant, held by one member. lockout.test.ts owns the
        // violation cases; ours must not trip it. See registry-service.test.ts:11-47.
        rbacModule: {
            update: vi.fn(),
            create: vi.fn(),
            // `delete` was absent until the refusal tests started asserting on
            // it — which means deleteModule's SUCCESS path was never exercised
            // either. Covered now, below.
            delete: vi.fn(),
            findMany: vi.fn().mockResolvedValue([{ id: 'm-settings', tenantId: null }]),
        },
        rbacAction: {
            create: vi.fn(),
            update: vi.fn(),
            delete: vi.fn(),
            findMany: vi.fn().mockResolvedValue([{ id: 'a-update', tenantId: null }]),
        },
        rbacRoleRule: {
            count: vi.fn().mockResolvedValue(0),
            findMany: vi.fn().mockResolvedValue([{ roleId: 'role-owner' }]),
            createMany: vi.fn(),
            deleteMany: vi.fn(),
        },
        // Empty, not a stubbed 'Settings' subject row: assertNoLockout treats a
        // missing subject as "no subject-level override exists" and falls back
        // to the module-level answer from rbacRoleRule.findMany above — the
        // same healthy-tenant default this file already applies at the module
        // layer. A real Prisma.TransactionClient always has this table; only
        // an incomplete stub was ever missing it (lib/rbac/lockout.ts:127).
        rbacSubject: { findMany: vi.fn().mockResolvedValue([]) },
        rbacSubjectModule: {
            // 'SpotGuard' currently lives in Schedules — the remap source.
            findFirst: vi.fn().mockResolvedValue({ id: 'sm-spotguard', moduleId: 'm-sched' }),
            update: vi.fn(),
            create: vi.fn(),
            // Non-zero so deleteModule's "still covers" refusal fires by default.
            count: vi.fn().mockResolvedValue(2),
        },
        rbacModuleAction: {
            findMany: vi.fn().mockResolvedValue([{ id: 'ma-1', actionId: 'a-read' }]),
            createMany: vi.fn(),
            deleteMany: vi.fn(),
        },
        customRole: { findMany: vi.fn().mockResolvedValue([{ name: 'Owner' }]) },
        userTenantRole: { count: vi.fn().mockResolvedValue(1) },
    };
    return {
        tx,
        prisma: {
            rbacModule: { findMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() },
            rbacAction: { findMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() },
            rbacSubject: { findMany: vi.fn() },
            rbacSubjectModule: { findMany: vi.fn() },
            rbacModuleAction: { findMany: vi.fn() },
            rbacRoleRule: { groupBy: vi.fn() },
            $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
        },
        logUserAction: vi.fn(),
    };
});
vi.mock('@/lib/db/pg-config', () => ({ getPrismaClient: () => h.prisma }));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: h.logUserAction } }));

import {
    createAction,
    createModule,
    deleteAction,
    deleteModule,
    SystemRowError,
    updateAction,
    updateModule,
} from './registry-admin-writes';

const actor = { userId: 'u1', email: 'admin@example.com', tenantId: 't1' };

/** Backs createAction's duplicate-key / alias-existence lookups via loadAdminRegistry. */
function seedActionsForWrites() {
    h.prisma.rbacModule.findMany.mockResolvedValue([]);
    h.prisma.rbacAction.findMany.mockResolvedValue([
        { id: 'sys-act-read', tenantId: null, key: 'read', label: 'Read', description: null, aliasOfKey: null, isDangerous: false, sortOrder: 20, isSystem: true },
        { id: 'sys-act-update', tenantId: null, key: 'update', label: 'Update', description: null, aliasOfKey: null, isDangerous: false, sortOrder: 30, isSystem: true },
    ]);
    h.prisma.rbacSubject.findMany.mockResolvedValue([]);
    h.prisma.rbacSubjectModule.findMany.mockResolvedValue([]);
    h.prisma.rbacModuleAction.findMany.mockResolvedValue([]);
    h.prisma.rbacRoleRule.groupBy.mockResolvedValue([]);
}

/** Backs updateAction/deleteAction's pre-write findUnique lookup. */
function seedActionRow(id: string, row: Record<string, unknown> | null) {
    h.prisma.rbacAction.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
        where.id === id ? row : null
    );
}

/**
 * Backs createModule/updateModule's registry lookups (via loadAdminRegistry)
 * for resolving actionKeys/subjectKeys to ids. 'CostControl' (m-cost) and
 * 'Accounts' (m-acc) are tenant-owned; 'Schedules' (m-sched) is where
 * 'SpotGuard' starts out, per the schema comment's own example remap.
 */
function seedModulesForWrites() {
    h.prisma.rbacModule.findMany.mockResolvedValue([
        { id: 'm-cost', tenantId: 't1', key: 'CostControl', label: 'Cost Control', description: null, icon: null, navPath: null, sortOrder: 100, enabled: true, isSystem: false },
        { id: 'm-sched', tenantId: null, key: 'Schedules', label: 'Schedules', description: null, icon: null, navPath: '/app/schedules', sortOrder: 20, enabled: true, isSystem: true },
        { id: 'm-acc', tenantId: 't1', key: 'Accounts', label: 'Accounts', description: null, icon: null, navPath: '/app/accounts', sortOrder: 10, enabled: true, isSystem: false },
    ]);
    // Ids deliberately distinct from the 'a-read' the tx-level rbacModuleAction
    // stub uses for the currently-linked cell — see the file header comment.
    h.prisma.rbacAction.findMany.mockResolvedValue([
        { id: 'act-read-id', tenantId: null, key: 'read', label: 'Read', description: null, aliasOfKey: null, isDangerous: false, sortOrder: 20, isSystem: true },
        { id: 'act-update-id', tenantId: null, key: 'update', label: 'Update', description: null, aliasOfKey: null, isDangerous: false, sortOrder: 30, isSystem: true },
    ]);
    h.prisma.rbacSubject.findMany.mockResolvedValue([
        { id: 's-spotguard', tenantId: null, key: 'SpotGuard', label: 'Fargate Spot Guard', kind: 'resource', isSystem: true },
        { id: 's-acc', tenantId: null, key: 'Account', label: 'AWS Account', kind: 'resource', isSystem: true },
    ]);
    h.prisma.rbacSubjectModule.findMany.mockResolvedValue([]);
    h.prisma.rbacModuleAction.findMany.mockResolvedValue([]);
    h.prisma.rbacRoleRule.groupBy.mockResolvedValue([]);
}

/** Backs updateModule/deleteModule's pre-write findUnique lookup. */
const MODULE_ROWS: Record<string, Record<string, unknown>> = {
    'm-cost': { id: 'm-cost', tenantId: 't1', key: 'CostControl', label: 'Cost Control', description: null, icon: null, navPath: null, sortOrder: 100, enabled: true, isSystem: false },
    'm-acc': { id: 'm-acc', tenantId: 't1', key: 'Accounts', label: 'Accounts', description: null, icon: null, navPath: '/app/accounts', sortOrder: 10, enabled: true, isSystem: false },
    'sys-mod-accounts': { id: 'sys-mod-accounts', tenantId: null, key: 'Accounts', label: 'Accounts', description: null, icon: null, navPath: '/app/accounts', sortOrder: 10, enabled: true, isSystem: true },
};

/**
 * Backs applyModuleSubjects' two-query lookup: this tenant's own link first,
 * falling back to the GLOBAL link. 'SpotGuard' starts out globally linked to
 * 'Schedules' (the schema comment's own remap example); 'Account' starts out
 * globally linked to its own module already, so editing 'm-acc' without
 * intending a remap is a no-op move.
 */
const GLOBAL_SUBJECT_LINKS: Record<string, { id: string; moduleId: string }> = {
    's-spotguard': { id: 'sm-spotguard', moduleId: 'm-sched' },
    's-acc': { id: 'sm-acc', moduleId: 'm-acc' },
};

/**
 * `rbacRoleRule.findMany` serves two callers with different predicates, and
 * conflating them is what let the remap tests pass the lockout invariant they
 * should have had to satisfy:
 *
 *   · assertNoLockout      — `moduleId` is a plain string ('m-settings')
 *   · materializeSubjectGrants — `moduleId` is `{ in: [from, to] }`
 *
 * `lockout` defaults to a healthy tenant: one role holding the unconditional
 * (Settings, update) grant. Pass `materialize` to supply the rules a remap
 * should see, without touching the invariant's answer.
 */
function stubRoleRules(
    opts: { lockout?: unknown[]; materialize?: unknown[]; subjectLevel?: unknown[] } = {}
): void {
    const { lockout = [{ roleId: 'role-owner' }], materialize = [], subjectLevel = [] } = opts;
    h.tx.rbacRoleRule.findMany.mockImplementation(
        async ({ where }: { where: { moduleId?: unknown; subjectId?: unknown } }) => {
            // Third predicate: the reap query asks by subjectId with a NULL
            // moduleId. `typeof null === 'object'` collides with materialize's
            // `{ in: [...] }`, so it must be discriminated first.
            if (where?.subjectId !== undefined) return subjectLevel;
            return typeof where?.moduleId === 'string' ? lockout : materialize;
        }
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    h.logUserAction.mockResolvedValue(undefined);
    h.prisma.$transaction.mockImplementation(async (fn: (t: typeof h.tx) => Promise<unknown>) => fn(h.tx));
    // ── Stubs that HONOUR their `where` ─────────────────────────────────────
    //
    // These two used to return a fixed array for every query, which quietly
    // disabled the lockout invariant: assertNoLockout looks for an enabled
    // 'Settings' module and an unconditional (Settings, update) grant held by a
    // member, and a stub that answers every question with the same row can
    // never fail to find one. Worse, the remap tests below replace
    // rbacRoleRule.findMany with rules granting neither Settings nor update —
    // so they passed the invariant only because the stub ignored the predicate.
    //
    // Keyed on `where` instead, the invariant can genuinely fail, and the remap
    // tests have to say which query they are answering.
    h.tx.rbacModule.findMany.mockImplementation(async ({ where }: { where: { key?: string } }) =>
        where?.key === 'Settings' ? [{ id: 'm-settings', tenantId: null }] : []
    );
    h.tx.rbacModule.create.mockResolvedValue({ id: 'm-new' });
    h.tx.rbacModule.update.mockResolvedValue({ id: 'm-updated' });
    h.tx.rbacAction.findMany.mockImplementation(async ({ where }: { where: { key?: string } }) =>
        where?.key === 'update' || where?.key === undefined ? [{ id: 'a-update', tenantId: null }] : []
    );
    stubRoleRules();
    h.tx.rbacRoleRule.count.mockResolvedValue(0);
    // No tenant-local subject-module override by default — only the global
    // link resolves. Tests exercising an existing tenant override set one via
    // h.tx.rbacSubjectModule.findFirst.mockImplementation(...) themselves.
    h.tx.rbacSubjectModule.findFirst.mockImplementation(
        async ({ where }: { where: { tenantId: string | null; subjectId: string } }) =>
            where.tenantId === null ? (GLOBAL_SUBJECT_LINKS[where.subjectId] ?? null) : null
    );
    h.tx.rbacSubjectModule.count.mockResolvedValue(2);
    h.tx.rbacModuleAction.findMany.mockResolvedValue([{ id: 'ma-1', actionId: 'a-read' }]);
    h.tx.customRole.findMany.mockResolvedValue([{ name: 'Owner' }]);
    h.tx.userTenantRole.count.mockResolvedValue(1);
    // No pre-existing tenant override by default — copy-on-write tests that
    // need one override this per-test.
    h.prisma.rbacAction.findFirst.mockResolvedValue(null);
    h.prisma.rbacModule.findFirst.mockResolvedValue(null);
    h.prisma.rbacModule.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => MODULE_ROWS[where.id] ?? null);
});

describe('createAction', () => {
    beforeEach(() => {
        seedActionsForWrites();
    });

    it('rejects a key that collides with a visible verb', async () => {
        await expect(
            createAction(actor, { key: 'read', label: 'Read Again' })
        ).rejects.toThrow(/already exists/i);
    });

    it('rejects a reserved key', async () => {
        await expect(
            createAction(actor, { key: 'manage', label: 'Manage' })
        ).rejects.toThrow(/reserved/i);
    });

    it('rejects a key that is not a lowercase identifier', async () => {
        await expect(
            createAction(actor, { key: 'Restart Service', label: 'Restart' })
        ).rejects.toThrow(/lowercase/i);
    });

    it('rejects an aliasOfKey that is not itself a verb', async () => {
        await expect(
            createAction(actor, { key: 'restart', label: 'Restart', aliasOfKey: 'bounce' })
        ).rejects.toThrow(/alias/i);
    });

    it('writes the row with the actor tenant, never global', async () => {
        await createAction(actor, { key: 'restart', label: 'Restart', aliasOfKey: 'update' });
        expect(h.tx.rbacAction.create).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ tenantId: 't1', key: 'restart' }) })
        );
    });

    /**
     * A label of only whitespace passes the client's `min(1)` check (length 3)
     * and, absent this guard, is written verbatim through `.trim()` at the
     * write boundary as an empty string — a permission row an administrator
     * can never identify in the role grid. Asserting on STATE, not just the
     * thrown error: an implementation that throws the right message while
     * still calling create would be exactly the regression to catch, per the
     * pattern already established for the built-in-row refusals above.
     */
    it('rejects a whitespace-only label, writing nothing', async () => {
        await expect(createAction(actor, { key: 'restart', label: '   ' })).rejects.toThrow(/label/i);
        expect(h.tx.rbacAction.create).not.toHaveBeenCalled();
    });
});

describe('deleteAction', () => {
    beforeEach(() => {
        seedActionRow('sys-act-read', {
            id: 'sys-act-read',
            tenantId: null,
            key: 'read',
            label: 'Read',
            description: null,
            aliasOfKey: null,
            isDangerous: false,
            sortOrder: 20,
            isSystem: true,
        });
    });

    it('refuses to delete a system row', async () => {
        await expect(deleteAction(actor, 'sys-act-read')).rejects.toThrow(SystemRowError);
    });

    it('refuses to delete a verb that roles still grant, and says how many', async () => {
        seedActionRow('a-restart', {
            id: 'a-restart',
            tenantId: 't1',
            key: 'restart',
            label: 'Restart',
            description: null,
            aliasOfKey: null,
            isDangerous: false,
            sortOrder: 100,
            isSystem: false,
        });
        h.tx.rbacRoleRule.count.mockResolvedValue(4);
        await expect(deleteAction(actor, 'a-restart')).rejects.toThrow(/4 grant/i);
        expect(h.tx.rbacAction.delete).not.toHaveBeenCalled();
    });

    it('deletes a verb no role grants', async () => {
        seedActionRow('a-restart', {
            id: 'a-restart',
            tenantId: 't1',
            key: 'restart',
            label: 'Restart',
            description: null,
            aliasOfKey: null,
            isDangerous: false,
            sortOrder: 100,
            isSystem: false,
        });
        h.tx.rbacRoleRule.count.mockResolvedValue(0);
        await deleteAction(actor, 'a-restart');
        expect(h.tx.rbacAction.delete).toHaveBeenCalledWith({ where: { id: 'a-restart' } });
    });
});

describe('updateAction', () => {
    beforeEach(() => {
        seedActionRow('sys-act-read', {
            id: 'sys-act-read',
            tenantId: null,
            key: 'read',
            label: 'Read',
            description: null,
            aliasOfKey: null,
            isDangerous: false,
            sortOrder: 20,
            isSystem: true,
        });
    });

    /**
     * A tenant may not edit a built-in row at all — not even its label.
     *
     * An override would have to carry a NEW id while every existing rule still
     * references the built-in's id, and mergeByKey() removes the shadowed row
     * from the snapshot, so actionById.get(rule.actionId) misses and the rule is
     * dropped as 'unknown-action'. Relabelling 'read' would have revoked read
     * for every role in the tenant. These tests assert the STATE — no row
     * written by either route — because an implementation that threw the right
     * message while still writing would be exactly the regression to catch.
     */
    it('refuses a cosmetic edit to a built-in row, writing nothing', async () => {
        await expect(updateAction(actor, 'sys-act-read', { label: 'View' })).rejects.toThrow(SystemRowError);
        expect(h.tx.rbacAction.update).not.toHaveBeenCalled();
        expect(h.tx.rbacAction.create).not.toHaveBeenCalled();
    });

    it('names the built-in and points at the alternative', async () => {
        await expect(updateAction(actor, 'sys-act-read', { label: 'View' })).rejects.toThrow(
            /'read' is a built-in permission and cannot be edited/i
        );
    });

    it('refuses a structural edit to a built-in row, writing nothing', async () => {
        await expect(updateAction(actor, 'sys-act-read', { key: 'view' })).rejects.toThrow(SystemRowError);
        expect(h.tx.rbacAction.create).not.toHaveBeenCalled();
        expect(h.tx.rbacAction.update).not.toHaveBeenCalled();
    });

    describe('re-keying / re-aliasing a tenant-owned row', () => {
        beforeEach(() => {
            seedActionsForWrites();
            seedActionRow('a-restart', {
                id: 'a-restart',
                tenantId: 't1',
                key: 'restart',
                label: 'Restart',
                description: null,
                aliasOfKey: null,
                isDangerous: false,
                sortOrder: 100,
                isSystem: false,
            });
        });

        it('rejects renaming a custom verb to a reserved key', async () => {
            await expect(updateAction(actor, 'a-restart', { key: 'manage' })).rejects.toThrow(/reserved/i);
        });

        it('rejects renaming a custom verb to a key that already exists', async () => {
            await expect(updateAction(actor, 'a-restart', { key: 'update' })).rejects.toThrow(/already exists/i);
        });

        it('rejects aliasing a verb to a key that does not exist', async () => {
            await expect(updateAction(actor, 'a-restart', { aliasOfKey: 'bounce' })).rejects.toThrow(/alias/i);
        });

        it('rejects aliasing a verb to itself', async () => {
            // Registry includes 'restart' as this very row so the alias-target-
            // exists check passes and the self-alias check is what fires.
            h.prisma.rbacAction.findMany.mockResolvedValue([
                { id: 'sys-act-read', tenantId: null, key: 'read', label: 'Read', description: null, aliasOfKey: null, isDangerous: false, sortOrder: 20, isSystem: true },
                { id: 'sys-act-update', tenantId: null, key: 'update', label: 'Update', description: null, aliasOfKey: null, isDangerous: false, sortOrder: 30, isSystem: true },
                { id: 'a-restart', tenantId: 't1', key: 'restart', label: 'Restart', description: null, aliasOfKey: null, isDangerous: false, sortOrder: 100, isSystem: false },
            ]);
            await expect(updateAction(actor, 'a-restart', { aliasOfKey: 'restart' })).rejects.toThrow(
                /alias of itself/i
            );
        });

        /**
         * Same trap as createAction's whitespace-only label, on the re-key/
         * re-label path. Asserting on STATE — no update call — not merely on
         * the thrown message.
         */
        it('rejects a whitespace-only label, writing nothing', async () => {
            await expect(updateAction(actor, 'a-restart', { label: '   ' })).rejects.toThrow(/label/i);
            expect(h.tx.rbacAction.update).not.toHaveBeenCalled();
        });
    });
});

describe('module writes', () => {
    beforeEach(() => {
        seedModulesForWrites();
    });

    describe('updateModule — subject remap', () => {
        /**
         * The trap documented on RbacSubjectModule. A role holding only
         * (Schedules, update) reaches SpotGuard because the compiler expands the
         * module rule over the module's subjects. Move SpotGuard to Cost Control and
         * that role loses it — with no rule edited and nothing in the UI to show it.
         */
        it('materializes a subject-level rule for every role that would lose access', async () => {
            stubRoleRules({ materialize: [
                { id: 'r1', roleId: 'role-ops', actionId: 'a-update', moduleId: 'm-sched', conditions: null, inverted: false, reason: null },
            ] });
            const result = await updateModule(actor, 'm-cost', {
                key: 'CostControl', label: 'Cost Control',
                actionKeys: ['read', 'update'], subjectKeys: ['SpotGuard'],
            });
            expect(result.materializedRules).toBe(1);
            expect(h.tx.rbacRoleRule.createMany).toHaveBeenCalledWith({
                data: [expect.objectContaining({ roleId: 'role-ops', actionId: 'a-update', subjectId: 's-spotguard', moduleId: null })],
                skipDuplicates: true,
            });
        });

        it('materializes nothing for a role that already holds the destination grant', async () => {
            stubRoleRules({ materialize: [
                { id: 'r1', roleId: 'role-ops', actionId: 'a-update', moduleId: 'm-sched', conditions: null, inverted: false, reason: null },
                { id: 'r2', roleId: 'role-ops', actionId: 'a-update', moduleId: 'm-cost', conditions: null, inverted: false, reason: null },
            ] });
            const result = await updateModule(actor, 'm-cost', {
                key: 'CostControl', label: 'Cost Control',
                actionKeys: ['read', 'update'], subjectKeys: ['SpotGuard'],
            });
            expect(result.materializedRules).toBe(0);
        });
    });

    /**
     * ── THE ORPHAN A ROUND TRIP LEAVES BEHIND ────────────────────────────────
     * Move a subject OUT of its module and every role's grant is materialized
     * as a subject-level rule. Move it BACK and materializeSubjectGrants finds
     * nothing to copy (the module rules never left the origin), so it creates
     * nothing — and the rules written by the outbound leg stay forever.
     *
     * They are then unrevokable: the roles grid writes only module-level rules
     * (role-rule-sync.ts), and the compiler's precise-beats-broad step makes
     * the leftover WIN over the module row it duplicates. Unticking the cell
     * removes the module rule and the subject-level one keeps granting.
     *
     * This is not hypothetical — it is exactly how ROLE1 kept `create Agent`
     * after AI Ops/Create was unticked.
     */
    describe('updateModule — subject remap reaps redundant leftovers', () => {
        it('deletes a subject-level rule the destination module already grants', async () => {
            stubRoleRules({
                materialize: [
                    { id: 'r1', roleId: 'role-ops', actionId: 'a-update', moduleId: 'm-cost', conditions: null, inverted: false, reason: null },
                ],
                subjectLevel: [
                    { id: 'sr-stale', roleId: 'role-ops', actionId: 'a-update', conditions: null, inverted: false },
                ],
            });

            const result = await updateModule(actor, 'm-cost', {
                key: 'CostControl', label: 'Cost Control',
                actionKeys: ['read', 'update'], subjectKeys: ['SpotGuard'],
            });

            expect(result.reapedRules).toBe(1);
            expect(h.tx.rbacRoleRule.deleteMany).toHaveBeenCalledWith({
                where: { id: { in: ['sr-stale'] } },
            });
        });

        /**
         * A grant the destination does NOT hold is the one materializeSubjectGrants
         * exists to preserve. Reaping it would re-introduce the silent revocation
         * this whole mechanism was built to prevent.
         */
        it('keeps a subject-level rule the destination module does not grant', async () => {
            stubRoleRules({
                materialize: [],
                subjectLevel: [
                    { id: 'sr-real', roleId: 'role-ops', actionId: 'a-update', conditions: null, inverted: false },
                ],
            });

            const result = await updateModule(actor, 'm-cost', {
                key: 'CostControl', label: 'Cost Control',
                actionKeys: ['read', 'update'], subjectKeys: ['SpotGuard'],
            });

            expect(result.reapedRules).toBe(0);
            expect(h.tx.rbacRoleRule.deleteMany).not.toHaveBeenCalled();
        });

        /**
         * A CONDITIONAL subject-level rule is not redundant with an
         * unconditional module grant — precise-beats-broad means it NARROWS the
         * module row rather than repeating it ("only your own accounts" vs
         * "all"). Reaping it would silently widen the role to every row.
         *
         * The (role, action) pair here matches the destination grant exactly, so
         * only the condition can save it: an implementation that keyed on
         * (role, action) alone would delete it and fail.
         */
        it('keeps a conditional subject-level rule even when the module grants the same verb', async () => {
            stubRoleRules({
                materialize: [
                    { id: 'r1', roleId: 'role-ops', actionId: 'a-update', moduleId: 'm-cost', conditions: null, inverted: false, reason: null },
                ],
                subjectLevel: [
                    {
                        id: 'sr-conditional', roleId: 'role-ops', actionId: 'a-update',
                        conditions: { accountId: { $in: { $var: 'user.allowedAccountIds' } } },
                        inverted: false,
                    },
                ],
            });

            const result = await updateModule(actor, 'm-cost', {
                key: 'CostControl', label: 'Cost Control',
                actionKeys: ['read', 'update'], subjectKeys: ['SpotGuard'],
            });

            expect(result.reapedRules).toBe(0);
            expect(h.tx.rbacRoleRule.deleteMany).not.toHaveBeenCalled();
        });

        /**
         * `cannot` rules never enter the candidate set — an inverted rule
         * REVERSES the module grant, so deleting one restores access the role
         * was explicitly denied. Guaranteed by the query predicate, which is
         * why the predicate itself is asserted here.
         */
        it('never asks the database for inverted rules', async () => {
            stubRoleRules({
                materialize: [
                    { id: 'r1', roleId: 'role-ops', actionId: 'a-update', moduleId: 'm-cost', conditions: null, inverted: false, reason: null },
                ],
                subjectLevel: [],
            });

            await updateModule(actor, 'm-cost', {
                key: 'CostControl', label: 'Cost Control',
                actionKeys: ['read', 'update'], subjectKeys: ['SpotGuard'],
            });

            const reapQuery = h.tx.rbacRoleRule.findMany.mock.calls
                .map((c: [{ where: Record<string, unknown> }]) => c[0].where)
                .find((w: Record<string, unknown>) => w.subjectId !== undefined);

            expect(reapQuery).toMatchObject({
                subjectId: 's-spotguard',
                moduleId: null,
                inverted: false,
            });
        });
    });

    describe('updateModule — subject remap does not touch the shared global link', () => {
        /**
         * 'SpotGuard' starts out linked only globally (tenantId null) — true of
         * every seeded system subject. Moving it for tenant 't1' must create a
         * TENANT-scoped link, never update the global row: doing the latter
         * would move SpotGuard for every other tenant too, the same class of
         * cross-tenant mutation Ruling 2 fixed for the module row itself.
         */
        it('creates a tenant-scoped link instead of updating the global one', async () => {
            stubRoleRules({ materialize: [
                { id: 'r1', roleId: 'role-ops', actionId: 'a-update', moduleId: 'm-sched', conditions: null, inverted: false, reason: null },
            ] });
            const result = await updateModule(actor, 'm-cost', {
                key: 'CostControl', label: 'Cost Control',
                actionKeys: ['read', 'update'], subjectKeys: ['SpotGuard'],
            });

            expect(h.tx.rbacSubjectModule.update).not.toHaveBeenCalled();
            expect(h.tx.rbacSubjectModule.create).toHaveBeenCalledWith({
                data: { tenantId: 't1', subjectId: 's-spotguard', moduleId: 'm-cost' },
            });
            expect(result.materializedRules).toBe(1);
        });

        it('moves this tenant\'s own override link when one already exists, rather than creating a second', async () => {
            h.tx.rbacSubjectModule.findFirst.mockImplementation(
                async ({ where }: { where: { tenantId: string | null; subjectId: string } }) => {
                    if (where.tenantId === 't1' && where.subjectId === 's-spotguard') {
                        return { id: 'sm-spotguard-t1', moduleId: 'm-sched' };
                    }
                    return where.tenantId === null ? (GLOBAL_SUBJECT_LINKS[where.subjectId] ?? null) : null;
                }
            );

            await updateModule(actor, 'm-cost', {
                key: 'CostControl', label: 'Cost Control',
                actionKeys: ['read', 'update'], subjectKeys: ['SpotGuard'],
            });

            expect(h.tx.rbacSubjectModule.create).not.toHaveBeenCalled();
            expect(h.tx.rbacSubjectModule.update).toHaveBeenCalledWith({
                where: { id: 'sm-spotguard-t1' },
                data: { moduleId: 'm-cost' },
            });
        });
    });

    describe('updateModule — removing a grantable cell', () => {
        // 'Account' already resolves (via the default GLOBAL_SUBJECT_LINKS
        // mock) to 'm-acc' — this describe block edits actionKeys only, not
        // subject coverage, so the subject link is already in place, not a
        // remap source.

        /**
         * grantable=false only affects `manage` expansion in the compiler
         * (rule-compiler.ts:244-251) — it does NOT stop an existing rule compiling.
         * Untick a cell with live grants and the permission stays in force while its
         * checkbox is gone from the grid: a grant nobody can see or revoke.
         */
        it('refuses without force when the cell still has grants, revoking nothing', async () => {
            h.tx.rbacRoleRule.count.mockResolvedValue(2);
            await expect(
                updateModule(actor, 'm-acc', { key: 'Accounts', label: 'Accounts', actionKeys: ['read'], subjectKeys: ['Account'] })
            ).rejects.toThrow(/2 role\(s\)/i);

            // The message is not the guarantee — the untouched state is. An
            // implementation that computed the right count and deleted anyway
            // would pass a message-only assertion.
            expect(h.tx.rbacRoleRule.deleteMany).not.toHaveBeenCalled();
            expect(h.tx.rbacModuleAction.deleteMany).not.toHaveBeenCalled();
        });

        it('deletes the orphaned grants when forced, scoped to the removed cells only', async () => {
            h.tx.rbacRoleRule.count.mockResolvedValue(2);
            const result = await updateModule(
                actor,
                'm-acc',
                { key: 'Accounts', label: 'Accounts', actionKeys: ['read'], subjectKeys: ['Account'] },
                { force: true }
            );
            expect(result.revokedRules).toBe(2);
            // Scoped to BOTH the module and the removed action set — a predicate
            // on the module alone would revoke grants on cells that survived.
            expect(h.tx.rbacRoleRule.deleteMany).toHaveBeenCalledWith({
                where: expect.objectContaining({
                    moduleId: 'm-acc',
                    actionId: { in: expect.arrayContaining([expect.any(String)]) },
                }),
            });
        });
    });

    describe('updateModule — label validation', () => {
        /**
         * Mirrors createModule's whitespace-only-label test, on the update
         * path. validateModuleInput() runs before the tenant/global branch, so
         * this fires before any row is even looked up — asserted here via the
         * STATE (no update call), matching the file's established pattern.
         */
        it('rejects a whitespace-only label, writing nothing', async () => {
            await expect(
                updateModule(actor, 'm-cost', {
                    key: 'CostControl', label: '   ', actionKeys: ['read'], subjectKeys: [],
                })
            ).rejects.toThrow(/label/i);
            expect(h.tx.rbacModule.update).not.toHaveBeenCalled();
        });
    });

    describe('updateModule — global row', () => {
        /**
         * A tenant may not edit a built-in module at all. Same reason as
         * updateAction: an override necessarily has a new id, no existing rule
         * points at it, and mergeByKey() drops the shadowed original from the
         * snapshot — so `moduleById.get(rule.moduleId)` misses and every grant
         * on the module is dropped as 'unknown-module'. A relabel would have
         * revoked the whole module for every role in the tenant.
         *
         * Asserting on STATE, not just the error: a version that throws while
         * still writing is the regression these exist to catch.
         */
        it('refuses a cosmetic edit to a built-in module, writing nothing', async () => {
            await expect(
                updateModule(actor, 'sys-mod-accounts', {
                    key: 'Accounts', label: 'AWS Accounts', actionKeys: ['read'], subjectKeys: [],
                })
            ).rejects.toThrow(SystemRowError);

            expect(h.tx.rbacModule.update).not.toHaveBeenCalled();
            expect(h.tx.rbacModule.create).not.toHaveBeenCalled();
        });

        it('names the built-in module and points at the alternative', async () => {
            await expect(
                updateModule(actor, 'sys-mod-accounts', {
                    key: 'Accounts', label: 'AWS Accounts', actionKeys: ['read'], subjectKeys: [],
                })
            ).rejects.toThrow(/'Accounts' is a built-in module and cannot be edited/i);
        });

        /**
         * A refused edit must not touch the module's coverage either. The
         * earlier copy-on-write implementation returned success with 0/0 while
         * silently discarding submitted actionKeys/subjectKeys — a form that
         * accepts input and drops it. Now nothing is written at all.
         */
        it('refuses without applying any submitted coverage change', async () => {
            await expect(
                updateModule(actor, 'sys-mod-accounts', {
                    key: 'Accounts',
                    label: 'Accounts',
                    actionKeys: ['read', 'update', 'delete'],
                    subjectKeys: ['SpotGuard'],
                })
            ).rejects.toThrow(SystemRowError);

            expect(h.tx.rbacModuleAction.createMany).not.toHaveBeenCalled();
            expect(h.tx.rbacModuleAction.deleteMany).not.toHaveBeenCalled();
            expect(h.tx.rbacSubjectModule.create).not.toHaveBeenCalled();
            expect(h.tx.rbacSubjectModule.update).not.toHaveBeenCalled();
        });

        /**
         * The SuperAdmin path is the one that legitimately owns a global row —
         * `assertTenantScoped` returns early for a null actor tenant precisely
         * for it. Task 3 left the equivalent branch on updateAction untested;
         * this is that test for updateModule.
         */
        it('lets a SuperAdmin edit the shared global row directly', async () => {
            const superAdmin = { userId: 'u2', email: 'super@example.com', tenantId: null };

            const result = await updateModule(superAdmin, 'sys-mod-accounts', {
                key: 'Accounts', label: 'AWS Accounts (global)', actionKeys: ['read'], subjectKeys: [],
            });

            expect(h.tx.rbacModule.create).not.toHaveBeenCalled();
            expect(h.tx.rbacModule.update).toHaveBeenCalledWith({
                where: { id: 'sys-mod-accounts' },
                data: expect.objectContaining({ label: 'AWS Accounts (global)' }),
            });
            expect(result.id).toBe('sys-mod-accounts');
        });

        it('refuses a structural edit to a global module (key stays refused)', async () => {
            await expect(
                updateModule(actor, 'sys-mod-accounts', {
                    key: 'Renamed', label: 'Accounts', actionKeys: ['read'], subjectKeys: [],
                })
            ).rejects.toThrow(SystemRowError);
            expect(h.tx.rbacModule.create).not.toHaveBeenCalled();
            expect(h.tx.rbacModule.update).not.toHaveBeenCalled();
        });
    });

    /**
     * Proof that the lockout invariant is observable at all.
     *
     * Every mutation in this file runs inside runRbacMutation, which calls
     * assertNoLockout AFTER the write so it sees the post-write world and rolls
     * back on violation. Until the stubs honoured their `where`, that check
     * could not fail here — a fixed return answered every query with a
     * surviving admin role. This test removes the surviving role and asserts
     * the mutation is refused, so a future stub that goes back to ignoring its
     * predicate fails loudly instead of silently disarming the invariant.
     */
    it('refuses a module write that would leave the tenant with no admin role', async () => {
        stubRoleRules({ lockout: [] });

        await expect(
            updateModule(actor, 'm-cost', {
                key: 'CostControl', label: 'Cost Control', actionKeys: ['read', 'update'], subjectKeys: [],
            })
        ).rejects.toThrow(/lockout|administer/i);
    });

    describe('deleteModule', () => {
        it('refuses a system row, deleting nothing', async () => {
            await expect(deleteModule(actor, 'sys-mod-accounts')).rejects.toThrow(SystemRowError);
            expect(h.tx.rbacModule.delete).not.toHaveBeenCalled();
        });

        it('refuses a module that still covers subjects, deleting nothing', async () => {
            await expect(deleteModule(actor, 'm-cost')).rejects.toThrow(/still covers/i);
            expect(h.tx.rbacModule.delete).not.toHaveBeenCalled();
        });

        /**
         * The success path had no coverage at all — `rbacModule.delete` was not
         * even stubbed, so both refusal branches were being asserted without
         * anything proving the delete happens when it should. A guard that
         * refuses everything would have passed the whole describe block.
         */
        it('deletes a tenant module that covers nothing and holds no grants', async () => {
            h.tx.rbacSubjectModule.count.mockResolvedValue(0);
            h.tx.rbacRoleRule.count.mockResolvedValue(0);

            await deleteModule(actor, 'm-cost');

            expect(h.tx.rbacModule.delete).toHaveBeenCalledWith({ where: { id: 'm-cost' } });
        });
    });

    describe('createModule', () => {
        it('rejects a key that is not PascalCase', async () => {
            await expect(
                createModule(actor, { key: 'cost control', label: 'Cost', actionKeys: ['read'], subjectKeys: [] })
            ).rejects.toThrow(/letters and digits/i);
        });

        it('requires at least one grantable permission', async () => {
            await expect(
                createModule(actor, { key: 'CostControl', label: 'Cost', actionKeys: [], subjectKeys: [] })
            ).rejects.toThrow(/at least one permission/i);
        });

        /**
         * Same gap as the permission label: whitespace passes the client's
         * `min(1)` check and, unguarded, is written as an empty string — a
         * module row that renders blank in the role grid header. Asserting on
         * STATE, not just the thrown message.
         */
        it('rejects a whitespace-only label, writing nothing', async () => {
            await expect(
                createModule(actor, { key: 'CostControl', label: '   ', actionKeys: ['read'], subjectKeys: [] })
            ).rejects.toThrow(/label/i);
            expect(h.tx.rbacModule.create).not.toHaveBeenCalled();
        });
    });
});
