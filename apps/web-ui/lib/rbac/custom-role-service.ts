import { getPrismaClient } from '@/lib/db/pg-config';
import type { PermissionSet, PredefinedRole } from './types';
import { getAutoLevel, ROLE_LEVELS, ROLE_PERMISSIONS } from './permissions';
import { runRbacMutation } from './registry-service';
import { syncRoleRules } from './role-rule-sync';
import type { SubjectOverrides } from './role-subject-overrides';
import { syncRoleSubjectOverrides } from './role-subject-overrides';
import { loadAdminRegistry, loadRoleModuleGrants, loadRoleSubjectOverrides } from './registry-admin';

/**
 * Who is changing permissions. Required rather than optional on purpose: every
 * role mutation must reach runRbacMutation, which needs an actor for the change
 * ledger and the version bump. An optional actor would let a caller silently
 * skip the rule sync and leave the engine disagreeing with the roles screen.
 */
export interface RoleActor {
    userId: string;
    email: string;
}

/**
 * runRbacMutation wants an entityId up front, but a create has no id until the
 * row exists. The ledger entry is written inside the same transaction, so this
 * placeholder never escapes to a reader that could act on it.
 */
const PENDING_ID = 'pending';

const MAX_CUSTOM_ROLES = 10;
const PREDEFINED_NAMES = new Set(['owner', 'admin', 'member', 'viewer']);

export interface CustomRoleInput {
    name: string;
    permissions: PermissionSet;
    /**
     * Subject-level exceptions to `permissions`. Absent means "no overrides",
     * NOT "leave existing overrides alone" — the sync is a set-reconciler, so an
     * older client that omits the field clears them. That is the safe direction:
     * the alternative is overrides nobody can see and nobody can remove.
     */
    overrides?: SubjectOverrides;
}

export interface CustomRoleOutput {
    id: string;
    tenantId: string;
    name: string;
    permissions: PermissionSet;
    overrides: SubjectOverrides;
    level: number;
    createdAt: Date;
    updatedAt: Date;
    createdBy: string;
}

function castRole(
    raw: {
        id: string;
        tenantId: string | null;
        name: string;
        permissions: unknown;
        level: number;
        createdAt: Date;
        updatedAt: Date;
        createdBy: string;
    },
    overrides: SubjectOverrides = {}
): CustomRoleOutput {
    return {
        ...raw,
        tenantId: raw.tenantId ?? '',
        permissions: raw.permissions as PermissionSet,
        overrides,
    };
}

/**
 * "Has something" must mean the same thing here as it does in
 * hasAnyPermission() (use-matrix-state.ts), which gates the client's Save
 * button: a module verb OR at least one subject-level override `grant`.
 * Denials do not count on either side — a role built only of `cannot` rules
 * authorizes nobody to do anything.
 *
 * Before this counted ONLY module-level actions, so a role with zero module
 * grants and one subject-level override grant (fully valid to the CASL
 * compiler — it emits `can('read', 'Provider')`) passed the client's Save
 * gate and then threw here, surfacing as an opaque 500 under the Role Name
 * field.
 */
function validateInput(input: CustomRoleInput): void {
    if (PREDEFINED_NAMES.has(input.name.toLowerCase())) {
        throw new Error(`Cannot use predefined role name: ${input.name}`);
    }
    const totalActions = Object.values(input.permissions).flat().length;
    const hasOverrideGrant = Object.values(input.overrides ?? {}).some((override) => override.grant.length > 0);
    if (totalActions === 0 && !hasOverrideGrant) {
        throw new Error('At least one permission action is required');
    }
}

export async function createCustomRole(
    tenantId: string,
    input: CustomRoleInput,
    actor: RoleActor
): Promise<CustomRoleOutput> {
    validateInput(input);

    const prisma = getPrismaClient();
    // Only count tenant-scoped custom roles (not global presets)
    const count = await prisma.customRole.count({ where: { tenantId, type: 'custom' } });
    if (count >= MAX_CUSTOM_ROLES) {
        throw new Error(`Maximum of ${MAX_CUSTOM_ROLES} custom roles per tenant reached`);
    }

    // The ceiling is the number of grantable cells in the REGISTRY, not in the
    // static Owner set. Without it, adding modules inflates every role's level,
    // and level 3 is what grants the right to assign roles.
    const { grantableCellCount } = await loadAdminRegistry(tenantId);
    const level = getAutoLevel(input.permissions, grantableCellCount);

    try {
        return await runRbacMutation(
            { actor: { ...actor, tenantId }, entityType: 'role', entityId: PENDING_ID, operation: 'create', after: input },
            async (tx) => {
                const role = await tx.customRole.create({
                    data: {
                        tenantId,
                        type: 'custom',
                        name: input.name,
                        permissions: input.permissions as object,
                        level,
                        createdBy: actor.email,
                    },
                });

                // Project the blob onto rbac_role_rules in the SAME transaction.
                // Without this the role exists but grants nothing under CASL, and
                // the screen that created it reports success.
                await syncRoleRules(tx, {
                    roleId: role.id,
                    tenantId,
                    permissions: input.permissions,
                    createdBy: actor.email,
                });

                // Module grants first, then the exceptions to them. Same
                // transaction: a partial sync would leave the engine disagreeing
                // with the screen that produced it.
                await syncRoleSubjectOverrides(tx, {
                    roleId: role.id,
                    tenantId,
                    overrides: input.overrides ?? {},
                    createdBy: actor.email,
                });

                return castRole(role, input.overrides ?? {});
            }
        );
    } catch (err: unknown) {
        if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'P2002') {
            throw new Error(`Role name '${input.name}' already exists in this tenant`);
        }
        throw err;
    }
}

export async function getCustomRoles(tenantId: string): Promise<CustomRoleOutput[]> {
    const prisma = getPrismaClient();
    const roles = await prisma.customRole.findMany({
        where: { tenantId, type: 'custom' },
        orderBy: { name: 'asc' },
    });
    const overridesByRoleId = await loadRoleSubjectOverrides(roles.map((r) => r.id), tenantId);
    return roles.map((r) => castRole(r, overridesByRoleId.get(r.id) ?? {}));
}

/**
 * The four predefined roles, from the DB where present and synthesized from code otherwise.
 *
 * These rows are created ONLY by libs/prisma/seed.ts, and the container entrypoint runs
 * `prisma migrate deploy` — never the seed. So any environment that was never manually seeded has
 * none, and this returned []. That emptied the Role dropdown in the invite-a-member dialog, making
 * it impossible to invite anyone: the UI derives its options from this list.
 *
 * Synthesizing is safe because these rows are a denormalized copy of constants that already live
 * in code, and nothing depends on the rows existing:
 *   - authorize() resolves the four predefined roles from ROLE_PERMISSIONS directly and only
 *     consults the DB for genuinely custom roles (see rbac/authorize.ts);
 *   - roles are referenced by NAME everywhere (invitations, user_tenant_roles), never by id;
 *   - custom_roles has no inbound foreign keys.
 *
 * DB rows still win when they exist, so a seeded environment behaves exactly as before and an
 * edited preset is preserved. Only the missing ones are filled in, which also keeps code and DB
 * from silently drifting apart.
 *
 * ── WHERE A PRESET'S PERMISSIONS COME FROM ──────────────────────────────────
 * NOT from `custom_roles.permissions`. 20260730000000_dynamic_abac inserts the four preset rows
 * with `permissions = '{}'::jsonb` deliberately and materialises their real grants as
 * `rbac_role_rules`, so reading the blob showed "No permissions" on every preset card in every
 * environment built by `migrate deploy`. They are read back from the rules instead — the same
 * place the CASL engine reads them from, which parity.test.ts proves agrees with the legacy
 * matrix for all four roles.
 *
 * ROLE_PERMISSIONS remains the fallback for a preset with NO rules at all. That means the
 * registry seed never ran, and in that state `authorize()` is still resolving presets from those
 * same code constants (the legacy path is the default and what production runs), so showing them
 * is what matches enforcement. Custom roles keep reading their blob: syncRoleRules() holds it
 * equal to the rules on every save, and the edit dialog round-trips it — deriving it here would
 * silently drop any blob key with no registry row on the next save.
 */
export async function getPresetRoles(tenantId?: string): Promise<CustomRoleOutput[]> {
    const prisma = getPrismaClient();
    const roles = await prisma.customRole.findMany({
        where: { type: 'preset' },
        orderBy: { level: 'desc' },
    });

    const [grantsByRoleId, overridesByRoleId] = await Promise.all([
        loadRoleModuleGrants(roles.map((r) => r.id), tenantId ?? null),
        loadRoleSubjectOverrides(roles.map((r) => r.id), tenantId ?? null),
    ]);

    const byName = new Map(
        roles.map((r) => {
            const role = castRole(r, overridesByRoleId.get(r.id) ?? {});
            const fromRules = grantsByRoleId.get(r.id);
            const fromCode = ROLE_PERMISSIONS[r.name as PredefinedRole] as PermissionSet | undefined;
            // Last resort is the row's own blob: a preset row named something outside the four
            // has no code constant to fall back to, and its blob is all that is left.
            return [r.name, { ...role, permissions: fromRules ?? fromCode ?? role.permissions }];
        })
    );
    const epoch = new Date(0); // fixed, not `new Date()`: these are code constants with no real timestamps

    const all = (Object.keys(ROLE_LEVELS) as PredefinedRole[]).map(
        (name) =>
            byName.get(name) ?? {
                id: `preset-${name.toLowerCase()}`, // matches the id the seed would have used
                tenantId: '',
                name,
                permissions: ROLE_PERMISSIONS[name] as PermissionSet,
                overrides: {},
                level: ROLE_LEVELS[name],
                createdAt: epoch,
                updatedAt: epoch,
                createdBy: 'system',
            },
    );

    return all.sort((a, b) => b.level - a.level);
}

export async function getCustomRole(tenantId: string, roleId: string): Promise<CustomRoleOutput | null> {
    const prisma = getPrismaClient();
    const role = await prisma.customRole.findFirst({ where: { id: roleId, tenantId } });
    if (!role) return null;
    const overridesByRoleId = await loadRoleSubjectOverrides([role.id], tenantId);
    return castRole(role, overridesByRoleId.get(role.id) ?? {});
}

export async function updateCustomRole(
    tenantId: string,
    roleId: string,
    input: CustomRoleInput,
    actor: RoleActor
): Promise<CustomRoleOutput> {
    validateInput(input);

    const prisma = getPrismaClient();
    // The ceiling is the number of grantable cells in the REGISTRY, not in the
    // static Owner set. Without it, adding modules inflates every role's level,
    // and level 3 is what grants the right to assign roles.
    const { grantableCellCount } = await loadAdminRegistry(tenantId);
    const level = getAutoLevel(input.permissions, grantableCellCount);
    const before = await prisma.customRole.findFirst({ where: { id: roleId, tenantId } });
    if (!before) throw new Error('Role not found');
    // Fetched BEFORE the update runs — this is the only point where the
    // pre-change overrides are still readable. Without it, a save that only
    // touches a subject override (no module permission change) writes a
    // ledger row where before === after, leaving no audit trail of what
    // actually changed.
    const beforeOverridesByRoleId = await loadRoleSubjectOverrides([roleId], tenantId);
    const beforeOverrides = beforeOverridesByRoleId.get(roleId) ?? {};

    return runRbacMutation(
        {
            actor: { ...actor, tenantId },
            entityType: 'role',
            entityId: roleId,
            operation: 'update',
            before: { permissions: before.permissions, overrides: beforeOverrides },
            after: { permissions: input.permissions, overrides: input.overrides ?? {} },
        },
        async (tx) => {
            const role = await tx.customRole.update({
                where: { id: roleId },
                data: { name: input.name, permissions: input.permissions as object, level },
            });

            // Revocations matter as much as grants here: without the sync,
            // unticking a box left the permission live in the engine.
            await syncRoleRules(tx, {
                roleId,
                tenantId,
                permissions: input.permissions,
                createdBy: actor.email,
            });

            await syncRoleSubjectOverrides(tx, {
                roleId,
                tenantId,
                overrides: input.overrides ?? {},
                createdBy: actor.email,
            });

            return castRole(role, input.overrides ?? {});
        }
    );
}

export async function deleteCustomRole(tenantId: string, roleId: string, actor: RoleActor): Promise<void> {
    const prisma = getPrismaClient();
    const before = await prisma.customRole.findFirst({ where: { id: roleId, tenantId } });
    if (!before) throw new Error('Role not found');

    await runRbacMutation(
        {
            actor: { ...actor, tenantId },
            entityType: 'role',
            entityId: roleId,
            operation: 'delete',
            before: before.permissions,
        },
        async (tx) => {
            // rbac_role_rules cascade on the role FK, so the rules go with it.
            // Routing through runRbacMutation is still required: it bumps the
            // RBAC version, without which cached abilities would keep granting
            // a deleted role until they expired.
            const deleted = await tx.customRole.delete({ where: { id: roleId } });
            await tx.userTenantRole.updateMany({
                where: { tenantId, role: deleted.name },
                data: { role: 'Viewer' },
            });
        }
    );
}

export async function getCustomRolePermissions(
    roleName: string,
    tenantId: string
): Promise<PermissionSet | null> {
    const prisma = getPrismaClient();
    // Try tenant-scoped custom role first, fall back to global preset
    const role = await prisma.customRole.findFirst({
        where: {
            OR: [
                { tenantId, name: roleName, type: 'custom' },
                { type: 'preset', name: roleName },
            ],
        },
        orderBy: { type: 'asc' }, // 'custom' < 'preset' — prefer tenant custom if both exist
    });
    return role ? (role.permissions as PermissionSet) : null;
}
