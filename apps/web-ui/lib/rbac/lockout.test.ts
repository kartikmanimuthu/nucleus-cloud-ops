/**
 * Lockout prevention (D-13).
 *
 * The transaction client is a stub — what is under test is the DECISION: which
 * surviving rules count as "someone can still administer permissions", and which
 * deliberately do not. The queries themselves are asserted where their shape is
 * load-bearing (the unconditional filter, above all).
 */

import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { assertNoLockout, RbacLockoutError } from './lockout';

const TENANT = 'tenant-a';

interface StubOptions {
    module?: { id: string } | null;
    action?: { id: string } | null;
    survivingRules?: Array<{ roleId: string }>;
    holderCount?: number;
    // Subject-override shape (Settings SUBJECT rules — distinct from the
    // Settings MODULE rules above). `modules`/`actions`/`moduleRules` are the
    // array forms of `module`/`action`/`survivingRules`, used together with
    // `subjects` when a test needs to drive the subject-rule query
    // independently of the module-rule query.
    modules?: Array<{ id: string; tenantId: string | null }>;
    actions?: Array<{ id: string; tenantId: string | null }>;
    subjects?: Array<{ id: string; key: string; tenantId: string | null }>;
    moduleRules?: Array<{ roleId: string }>;
    subjectRules?: Array<{ roleId: string; subjectId: string; actionId: string; inverted: boolean }>;
    roles?: Array<{ id: string; name: string }>;
    memberCount?: number;
}

function stubTx(opts: StubOptions = {}) {
    const {
        module = { id: 'm-settings' },
        action = { id: 'a-update' },
        survivingRules = [{ roleId: 'role-owner' }],
        holderCount,
        modules,
        actions,
        subjects = [],
        moduleRules,
        subjectRules = [],
        roles,
        memberCount,
    } = opts;

    const moduleRows = modules ?? (module ? [module] : []);
    const actionRows = actions ?? (action ? [action] : []);
    const moduleRuleRows = moduleRules ?? survivingRules;
    const holders = memberCount ?? holderCount ?? 1;

    // Explicit id -> name lookup for tests that care which roles resolve to
    // which names (the subject-override tests do); falls back to the
    // pre-existing `name-${roleId}` synthesis otherwise, which every prior
    // test still relies on.
    const roleNameById = new Map((roles ?? []).map((r) => [r.id, r.name]));

    return {
        // findMany, not findFirst: tenant-vs-global precedence is resolved in JS
        // because Postgres sorts DESC with NULLS FIRST. `module`/`action` here are
        // the single row the registry would return; null models 'absent'.
        rbacModule: { findMany: vi.fn().mockResolvedValue(moduleRows) },
        rbacAction: { findMany: vi.fn().mockResolvedValue(actionRows) },
        rbacSubject: { findMany: vi.fn().mockResolvedValue(subjects) },
        // Serves both the module-rule query and the subject-rule query, keyed
        // on whether `where.subjectId` is present — that's how the two calls
        // assertNoLockout makes are told apart.
        rbacRoleRule: {
            findMany: vi.fn(async (args: { where: Record<string, unknown> }) =>
                'subjectId' in args.where && args.where.subjectId !== null ? subjectRules : moduleRuleRows
            ),
        },
        // Resolves surviving role ids to NAMES: membership is recorded by name,
        // not id, so the holder count has to match on both.
        customRole: {
            findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
                args.where.id.in.map((id) => ({ name: roleNameById.get(id) ?? `name-${id}` }))
            ),
        },
        userTenantRole: { count: vi.fn().mockResolvedValue(holders) },
    } as never;
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('assertNoLockout', () => {
    it('passes when a role still grants update Settings and someone holds it', async () => {
        await expect(assertNoLockout(stubTx(), TENANT)).resolves.toBeUndefined();
    });

    it('rejects when the last admin grant is removed', async () => {
        await expect(assertNoLockout(stubTx({ survivingRules: [] }), TENANT)).rejects.toThrow(RbacLockoutError);
    });

    it('rejects the self-demotion path — the grant survives but nobody holds it', async () => {
        // The likeliest way to hit this: the only admin changes their own role,
        // leaving a perfectly good admin role with zero members. A check that
        // only counted RULES would wave this through.
        await expect(assertNoLockout(stubTx({ holderCount: 0 }), TENANT)).rejects.toThrow(
            /no member able to administer/i
        );
    });

    it('counts only UNCONDITIONAL, non-inverted grants', async () => {
        // The subtle hole: a conditional grant may evaluate false for every real
        // row, so allowing it to satisfy the invariant would let an admin lock
        // the tenant out while appearing to leave an admin in place.
        const tx = stubTx();
        await assertNoLockout(tx, TENANT);

        const where = (tx as never as { rbacRoleRule: { findMany: ReturnType<typeof vi.fn> } })
            .rbacRoleRule.findMany.mock.calls[0][0].where;

        expect(where.inverted).toBe(false);

        // Prisma.DbNull, not null. This assertion previously demanded
        // `{ equals: null }` — the shape the implementation actually sent, and
        // the reason the bug survived: on a nullable Json column Prisma reads a
        // bare null as the JSON value null, so the filter matched ZERO rows and
        // the guard threw on every mutation. The test pinned the defect instead
        // of the intent.
        expect(where.conditions).toEqual({ equals: Prisma.DbNull });

        // Tenant-local OR global: admin comes from the Owner and Admin presets,
        // which are global rows an exact tenantId match cannot see.
        expect(where.OR).toEqual([{ tenantId: TENANT }, { tenantId: null }]);
    });

    it('scopes the holder count to the surviving roles, not to the tenant at large', async () => {
        // Counting every member of the tenant would pass whenever the tenant has
        // any members at all — which is always.
        const tx = stubTx({ survivingRules: [{ roleId: 'role-owner' }, { roleId: 'role-admin' }] });
        await assertNoLockout(tx, TENANT);

        const where = (tx as never as { userTenantRole: { count: ReturnType<typeof vi.fn> } })
            .userTenantRole.count.mock.calls[0][0].where;

        // Matches on id OR name. Counting on roleId alone found ZERO members,
        // because user_tenant_roles.roleId is null for every real assignment —
        // so this guard threw a lockout it had invented, on every mutation.
        expect(where.OR).toEqual([
            { roleId: { in: ['role-owner', 'role-admin'] } },
            { role: { in: ['name-role-owner', 'name-role-admin'] } },
        ]);
        expect(where.tenantId).toBe(TENANT);
    });

    it('requires the Settings module to be ENABLED', async () => {
        // A grant through a disabled module contributes nothing at compile time,
        // so it must not count as the surviving admin path either.
        const tx = stubTx();
        await assertNoLockout(tx, TENANT);

        const where = (tx as never as { rbacModule: { findMany: ReturnType<typeof vi.fn> } })
            .rbacModule.findMany.mock.calls[0][0].where;

        expect(where.enabled).toBe(true);
    });

    it('throws rather than passing when the registry has no Settings module', async () => {
        // Silently passing would hide a broken registry behind a green check.
        await expect(assertNoLockout(stubTx({ module: null }), TENANT)).rejects.toThrow(
            /Cannot verify the lockout invariant/i
        );
    });

    it('throws rather than passing when the registry has no update action', async () => {
        await expect(assertNoLockout(stubTx({ action: null }), TENANT)).rejects.toThrow(
            /Cannot verify the lockout invariant/i
        );
    });

    // isAdmin() evaluates can('update', 'Settings') against the Settings
    // SUBJECT, so a subject-level deny kills admin access while the module-level
    // rule this guard counts is still sitting there looking healthy. Without
    // this, the permission system can still delete its own escape hatch — just
    // one level lower than before.
    it('does not count a role whose Settings subject is denied update', async () => {
        const tx = stubTx({
            modules: [{ id: 'm-settings', tenantId: null }],
            actions: [{ id: 'a-update', tenantId: null }],
            subjects: [{ id: 's-settings', key: 'Settings', tenantId: null }],
            moduleRules: [{ roleId: 'role-admin' }],
            subjectRules: [
                { roleId: 'role-admin', subjectId: 's-settings', actionId: 'a-update', inverted: true },
            ],
            roles: [{ id: 'role-admin', name: 'Admin' }],
            memberCount: 1,
        });

        await expect(assertNoLockout(tx as never, 't1')).rejects.toThrow(RbacLockoutError);
    });

    it('counts a role granted update on the Settings subject directly', async () => {
        const tx = stubTx({
            modules: [{ id: 'm-settings', tenantId: null }],
            actions: [{ id: 'a-update', tenantId: null }],
            subjects: [{ id: 's-settings', key: 'Settings', tenantId: null }],
            moduleRules: [],
            subjectRules: [
                { roleId: 'role-admin', subjectId: 's-settings', actionId: 'a-update', inverted: false },
            ],
            roles: [{ id: 'role-admin', name: 'Admin' }],
            memberCount: 1,
        });

        await expect(assertNoLockout(tx as never, 't1')).resolves.toBeUndefined();
    });
});
