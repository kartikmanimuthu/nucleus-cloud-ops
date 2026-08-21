/**
 * Lockout prevention (D-13, plan §13.8).
 *
 * THE INVARIANT: a tenant must always retain at least one role that grants
 * administration of Settings, held by at least one member.
 *
 * Without it, the permission system can delete its own escape hatch. An admin
 * removing `update Settings` from the only role that has it — or demoting
 * themselves, which is the likeliest way to hit this — leaves a tenant where
 * nobody can edit permissions and the only remedy is a SuperAdmin with database
 * access. That is an outage caused by a UI click.
 *
 * Checked INSIDE the mutation transaction, after the write, so it sees the
 * post-write world and rolls the write back when it fails. Checking before the
 * write would be checking the wrong state.
 */

import { Prisma } from '@prisma/client';

import type { RbacTransaction } from './registry-service';

/**
 * The predicate for "can administer permissions".
 *
 * `update` on Settings, matching isAdmin() in authorize.ts. Not `manage`: the
 * compiler expands a manage grant into concrete actions and never emits the
 * CASL wildcard, so no compiled rule ever carries action 'manage' and a check
 * for it would match nothing. See the divergence note in authorize.ts.
 */
const ADMIN_MODULE_KEY = 'Settings';
const ADMIN_ACTION_KEY = 'update';

/**
 * isAdmin() asks CASL about the 'Settings' SUBJECT, not the module — the
 * compiler expands a module grant into one rule per subject and never emits a
 * rule named after the module. So the subject is where a deny actually bites.
 */
const ADMIN_SUBJECT_KEY = 'Settings';

export class RbacLockoutError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RbacLockoutError';
    }
}

/**
 * Throws if the tenant would be left with no one able to administer permissions.
 *
 * ── WHAT COUNTS, AND WHAT DELIBERATELY DOES NOT ─────────────────────────────
 * A qualifying rule must be:
 *   · non-inverted        — a `cannot` rule grants nothing;
 *   · UNCONDITIONAL       — this is the subtle one. A conditional grant
 *                           ("update Settings where accountId in …") may
 *                           evaluate false for every actual row, so counting it
 *                           would let an admin satisfy the invariant with a rule
 *                           that grants nobody anything in practice;
 *   · on an ENABLED module — the compiler contributes nothing for a disabled
 *                           module, so a grant through one is already dead.
 *
 * And the role must be held by at least one member: a perfectly good admin role
 * with no members is exactly as useless as no role at all.
 */
export async function assertNoLockout(tx: RbacTransaction, tenantId: string): Promise<void> {
    // `OR: [{ tenantId }, { tenantId: null }]` rather than `in: [tenantId, null]`:
    // Prisma rejects a null inside `in` on a String field at RUNTIME ("Expected
    // ListStringFieldRefInput or Null, provided (String, Null)"). Every test here
    // stubs the transaction, so the invalid shape passed unnoticed until a real
    // role edit reached it. Matches registry.ts's globalOrTenant() helper.
    const scope = { OR: [{ tenantId }, { tenantId: null }] };

    // A tenant override of a system row wins over the global row of the same key.
    // Selected in JS below rather than with `orderBy: { tenantId: 'desc' }`,
    // because Postgres sorts DESC with NULLS FIRST — so the global row arrives
    // first and "take the first" would pick precisely the wrong one.
    const [modules, actions] = await Promise.all([
        tx.rbacModule.findMany({
            where: { ...scope, key: ADMIN_MODULE_KEY, enabled: true },
            select: { id: true, tenantId: true },
        }),
        tx.rbacAction.findMany({
            where: { ...scope, key: ADMIN_ACTION_KEY },
            select: { id: true, tenantId: true },
        }),
    ]);

    const preferTenantLocal = <T extends { tenantId: string | null }>(rows: T[]): T | null =>
        rows.find((r) => r.tenantId !== null) ?? rows[0] ?? null;

    const module = preferTenantLocal(modules);
    const action = preferTenantLocal(actions);

    // If the registry lacks the module or action entirely, there is no invariant
    // to enforce and nothing this function can meaningfully assert. Fail loudly
    // rather than silently passing — a missing Settings module is itself a
    // broken registry, and passing here would hide it.
    if (!module || !action) {
        throw new RbacLockoutError(
            `Cannot verify the lockout invariant: the registry has no enabled '${ADMIN_MODULE_KEY}' module ` +
                `or no '${ADMIN_ACTION_KEY}' action for tenant ${tenantId}.`
        );
    }

    const survivingAdminRoles = await tx.rbacRoleRule.findMany({
        where: {
            // Tenant-local rules AND global ones. Admin comes from the Owner and
            // Admin PRESETS, which are global rows (tenantId null) — an exact
            // `tenantId` match cannot see them, so a tenant whose only local
            // admin grant was being edited would trip a false lockout while two
            // perfectly good preset roles still held the permission.
            OR: [{ tenantId }, { tenantId: null }],
            moduleId: module.id,
            actionId: action.id,
            inverted: false,
            // `Prisma.DbNull`, not `null`. On a nullable Json column Prisma reads
            // a bare `null` as "the JSON value null", not SQL NULL, so
            // `{ equals: null }` matched ZERO rows even though every rule has
            // conditions IS NULL — making this guard throw on every mutation.
            // Verified against the database: 0 rows vs 3 with DbNull.
            conditions: { equals: Prisma.DbNull },
        },
        select: { roleId: true },
        distinct: ['roleId'],
    });

    const settingsSubject = preferTenantLocal(
        await tx.rbacSubject.findMany({
            where: { ...scope, key: ADMIN_SUBJECT_KEY },
            select: { id: true, tenantId: true },
        })
    );

    // Subject-level rules on 'Settings' for the admin action. Unconditional
    // only, for the same reason the module query is: a conditional grant may
    // evaluate false for every real row, so counting it would let an admin
    // satisfy the invariant with a rule that grants nobody anything.
    const subjectRules = settingsSubject
        ? await tx.rbacRoleRule.findMany({
              where: {
                  OR: [{ tenantId }, { tenantId: null }],
                  subjectId: settingsSubject.id,
                  actionId: action.id,
                  conditions: { equals: Prisma.DbNull },
              },
              select: { roleId: true, inverted: true },
          })
        : [];

    const deniedRoleIds = new Set(subjectRules.filter((r) => r.inverted).map((r) => r.roleId));
    const directlyGrantedRoleIds = subjectRules.filter((r) => !r.inverted).map((r) => r.roleId);

    // A deny beats the module grant it shadows (rule-compiler.ts step 6 emits
    // every `cannot` last, so CASL gives it precedence). A direct subject grant
    // qualifies a role that holds no module rule at all.
    const qualifyingRoleIds = [
        ...new Set(
            [...survivingAdminRoles.map((r) => r.roleId), ...directlyGrantedRoleIds].filter(
                (roleId) => !deniedRoleIds.has(roleId)
            )
        ),
    ];

    if (qualifyingRoleIds.length === 0) {
        throw new RbacLockoutError(
            `This change would leave no role able to administer permissions. ` +
                `At least one role must keep '${ADMIN_ACTION_KEY} ${ADMIN_MODULE_KEY}' without conditions ` +
                `and without a '${ADMIN_SUBJECT_KEY}' deny.`
        );
    }

    const survivingRoleIds = qualifyingRoleIds;

    // Membership is recorded by role NAME, not id: user_tenant_roles.roleId is
    // nullable and is null for every row in practice — including custom roles —
    // because assignments are written by name (see the model comment: "null for
    // predefined roles"). Counting on roleId alone therefore matched ZERO members
    // and this guard could never pass, blocking every mutation with a lockout it
    // had invented. Verified against the database: 0 by id, 2 by name.
    //
    // Both are accepted so the check keeps working if roleId is ever populated.
    const survivingRoleNames = (
        await tx.customRole.findMany({
            where: { id: { in: survivingRoleIds } },
            select: { name: true },
        })
    ).map((r) => r.name);

    const heldByAnyone = await tx.userTenantRole.count({
        where: {
            tenantId,
            OR: [{ roleId: { in: survivingRoleIds } }, { role: { in: survivingRoleNames } }],
        },
    });

    if (heldByAnyone === 0) {
        throw new RbacLockoutError(
            `This change would leave no member able to administer permissions. ` +
                `At least one member must hold a role granting '${ADMIN_ACTION_KEY} ${ADMIN_MODULE_KEY}'.`
        );
    }
}
