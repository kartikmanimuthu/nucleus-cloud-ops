/**
 * Registry WRITES for permissions (verbs) and modules — the columns and rows
 * of the role grid.
 *
 * Every mutation below goes through runRbacMutation() from registry-service.ts:
 * that is what supplies the transaction, runs the D-13 lockout invariant after
 * the write, appends the append-only change-log row and bumps the RBAC version
 * that invalidates cached compiled abilities. A registry write outside it
 * produces a database that looks correct while the running app keeps serving
 * stale permissions.
 *
 * Split out of registry-admin.ts (which keeps the reads + types) once this
 * file grew a third concern — module writes — on top of the original verb
 * writes below.
 */

import { getPrismaClient } from '@/lib/db/pg-config';

import { loadAdminRegistry } from './registry-admin';
import {
    assertTenantScoped,
    runRbacMutation,
    type RbacActor,
    type RbacTransaction,
} from './registry-service';

/** Thrown when a delete would destroy live grants. Maps to HTTP 409. */
export class RegistryInUseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RegistryInUseError';
    }
}

/** Thrown when a tenant tries to restructure a global system row. HTTP 403. */
export class SystemRowError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SystemRowError';
    }
}

/**
 * Verb keys are lowercase identifiers because that is what call sites pass to
 * authorize() — `authorize('restart', 'SpotGuard')`. A key that does not match
 * this shape can never be reached by code, only by an alias.
 */
export const ACTION_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * `manage` expands to a module's grantable verbs at compile time and `all` is
 * CASL's subject wildcard. Neither may be redefined as an ordinary row: doing so
 * would either shadow the expansion or emit a rule matching every subject.
 */
export const RESERVED_ACTION_KEYS: ReadonlySet<string> = new Set(['manage', 'all']);

export interface ActionInput {
    key: string;
    label: string;
    description?: string | null;
    aliasOfKey?: string | null;
    isDangerous?: boolean;
    sortOrder?: number;
}

/**
 * Shared key/alias validation for createAction and a re-keying/re-aliasing
 * updateAction. Factored out so the two call sites cannot drift apart — that
 * drift is exactly how updateAction shipped with none of these checks the
 * first time.
 *
 * `tenantId` is the registry being checked against (the ROW's owning tenant,
 * not necessarily the actor's — a SuperAdmin editing a tenant row still must
 * collide-check against that tenant's registry). `excludeId` omits the row
 * under edit from the duplicate-key check, since an unchanged key legitimately
 * matches its own current row.
 */
async function validateActionKeyAndAlias(
    tenantId: string,
    key: string,
    aliasOfKey: string | null,
    excludeId?: string
): Promise<void> {
    if (!ACTION_KEY_PATTERN.test(key)) {
        throw new Error(`'${key}' is not a valid permission key — use a lowercase identifier such as 'restart'.`);
    }
    if (RESERVED_ACTION_KEYS.has(key)) {
        throw new Error(`'${key}' is reserved by the permission engine and cannot be redefined.`);
    }

    const registry = await loadAdminRegistry(tenantId);
    if (registry.actions.some((a) => a.key === key && a.id !== excludeId)) {
        throw new Error(`A permission named '${key}' already exists.`);
    }
    if (aliasOfKey && !registry.actions.some((a) => a.key === aliasOfKey)) {
        throw new Error(`Cannot alias '${key}' to '${aliasOfKey}' — no such permission.`);
    }
    if (aliasOfKey === key) {
        throw new Error(`A permission cannot be an alias of itself.`);
    }
}

export async function createAction(actor: RbacActor, input: ActionInput): Promise<{ id: string }> {
    if (actor.tenantId === null) throw new SystemRowError('Global registry authoring is not available here.');

    const key = input.key.trim();
    const label = input.label.trim();
    if (!label) {
        throw new Error('A permission needs a label — it cannot be blank or made of only whitespace.');
    }
    await validateActionKeyAndAlias(actor.tenantId, key, input.aliasOfKey ?? null);

    return runRbacMutation(
        { actor, entityType: 'action', entityId: key, operation: 'create', after: input },
        async (tx) =>
            tx.rbacAction.create({
                data: {
                    tenantId: actor.tenantId,
                    key,
                    label,
                    description: input.description ?? null,
                    aliasOfKey: input.aliasOfKey ?? null,
                    isDangerous: input.isDangerous ?? false,
                    sortOrder: input.sortOrder ?? 100,
                    isSystem: false,
                    createdBy: actor.email,
                },
                select: { id: true },
            })
    );
}

export async function updateAction(
    actor: RbacActor,
    actionId: string,
    input: Partial<ActionInput>,
    reason?: string
): Promise<void> {
    const prisma = getPrismaClient();
    const before = await prisma.rbacAction.findUnique({ where: { id: actionId } });
    if (!before) throw new Error('Permission not found');

    const patch: Record<string, unknown> = {};
    if (input.label !== undefined) {
        const label = input.label.trim();
        if (!label) {
            throw new Error('A permission needs a label — it cannot be blank or made of only whitespace.');
        }
        patch.label = label;
    }
    if (input.description !== undefined) patch.description = input.description;
    if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
    if (input.key !== undefined && input.key !== before.key) patch.key = input.key.trim();
    if (input.aliasOfKey !== undefined) patch.aliasOfKey = input.aliasOfKey;
    if (input.isDangerous !== undefined) patch.isDangerous = input.isDangerous;

    if (Object.keys(patch).length === 0) return;

    if (before.tenantId === null) {
        if (actor.tenantId === null) {
            // SuperAdmin editing the shared row directly IS global system-row
            // authoring — the path assertTenantScoped's contract reserves for it.
            await runRbacMutation(
                { actor, entityType: 'action', entityId: actionId, operation: 'update', before, after: patch, reason },
                async (tx) => {
                    await tx.rbacAction.update({ where: { id: actionId }, data: patch });
                }
            );
            return;
        }

        // ── WHY A TENANT MAY NOT EDIT A BUILT-IN ROW AT ALL ─────────────────
        //
        // Two options were rejected before this one, and both failed for the
        // same reason: THE COMPILER RESOLVES GRANTS BY ROW ID.
        //
        // Mutating the shared row in place is a cross-tenant write — every
        // other tenant reads it too, and assertTenantScoped's contract
        // (registry-service.ts) reserves `tenantId: null` for SuperAdmin.
        //
        // Copy-on-write looked right and is not: the override gets a NEW id
        // while every existing rule still references the global one, and
        // mergeByKey() removes the shadowed global row from the snapshot. So
        // actionById.get(rule.actionId) misses (rule-compiler.ts:288-297) and
        // the rule is dropped as 'unknown-action'. Relabelling 'read' to
        // 'View' silently revoked read for every role in the tenant. Nor can
        // the rules be re-pointed: the four preset roles' rules are GLOBAL rows
        // shared by all tenants, so re-pointing them corrupts other tenants and
        // leaving them drops them for this one.
        //
        // Creating a tenant's OWN permissions is unaffected — only editing a
        // built-in is refused. Tasks 7/8 disable these fields for global rows,
        // so this message is the API-level backstop, not the primary UX.
        throw new SystemRowError(
            `'${before.key}' is a built-in permission and cannot be edited. Create your own permission instead.`
        );
    }

    assertTenantScoped(actor.tenantId, before.tenantId);

    if (patch.key !== undefined || patch.aliasOfKey !== undefined) {
        const finalKey = patch.key !== undefined ? (patch.key as string) : before.key;
        const finalAliasOfKey =
            patch.aliasOfKey !== undefined ? (patch.aliasOfKey as string | null) : before.aliasOfKey;
        await validateActionKeyAndAlias(before.tenantId, finalKey, finalAliasOfKey, actionId);
    }

    await runRbacMutation(
        { actor, entityType: 'action', entityId: actionId, operation: 'update', before, after: patch, reason },
        async (tx) => {
            await tx.rbacAction.update({ where: { id: actionId }, data: patch });
        }
    );
}

export async function deleteAction(actor: RbacActor, actionId: string, reason?: string): Promise<void> {
    const prisma = getPrismaClient();
    const before = await prisma.rbacAction.findUnique({ where: { id: actionId } });
    if (!before) throw new Error('Permission not found');
    if (before.tenantId === null) {
        throw new SystemRowError(
            `'${before.key}' is a system permission and cannot be deleted. Remove it from every module instead — ` +
                `it then disappears from the role grid without destroying any grant.`
        );
    }
    assertTenantScoped(actor.tenantId, before.tenantId);

    await runRbacMutation(
        { actor, entityType: 'action', entityId: actionId, operation: 'delete', before, reason },
        async (tx) => {
            // The FK cascades. Counting first turns a silent mass revocation
            // into a refusal that names the number.
            const grants = await tx.rbacRoleRule.count({ where: { actionId } });
            if (grants > 0) {
                throw new RegistryInUseError(
                    `'${before.key}' is used in ${grants} grant(s) across roles. Deleting it would revoke them. ` +
                        `Remove it from every module first, or untick it in each role.`
                );
            }
            await tx.rbacAction.delete({ where: { id: actionId } });
        }
    );
}

/**
 * Registry WRITES for modules — the rows of the role grid. A module carries
 * three writes that must commit together: the module row itself, its
 * grantable verbs (RbacModuleAction) and its covered subjects
 * (RbacSubjectModule). Two of those can silently revoke access — see
 * materializeSubjectGrants() and applyModuleActions() below.
 */

/** Module keys are PascalCase identifiers, matching every seeded key. */
export const MODULE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;

export interface ModuleInput {
    key: string;
    label: string;
    description?: string | null;
    icon?: string | null;
    navPath?: string | null;
    sortOrder?: number;
    enabled?: boolean;
    /** Verb keys that become grantable cells on this module. */
    actionKeys: string[];
    /** Subject keys this module covers. Moving one materializes grants first. */
    subjectKeys: string[];
}

export interface ModuleWriteResult {
    id: string;
    /** Subject-level rules created to preserve access across a remap. */
    materializedRules: number;
    /** Module-level rules deleted because their cell stopped being grantable. */
    revokedRules: number;
    /**
     * Subject-level rules deleted because the module the subject just landed on
     * already grants them — see reapRedundantSubjectGrants().
     */
    reapedRules: number;
}

/**
 * Preserves access across a subject remap.
 *
 * When subject S moves from module A to module B, every role holding
 * (A, verb) but not (B, verb) silently loses S — the compiler expands a module
 * rule over the module's CURRENT subjects, so the grant evaporates with no rule
 * edited. This writes the explicit subject-level rule that keeps it, which the
 * schema comment on RbacSubjectModule calls for. Conditions and `inverted` are
 * copied verbatim: a conditional grant must stay exactly as conditional.
 */
async function materializeSubjectGrants(
    tx: RbacTransaction,
    opts: { tenantId: string; subjectId: string; fromModuleId: string; toModuleId: string; createdBy: string }
): Promise<{ materialized: number; reaped: number }> {
    const { tenantId, subjectId, fromModuleId, toModuleId, createdBy } = opts;

    // Scoped to this tenant plus the globals. `fromModuleId` is normally a
    // GLOBAL module id (every seeded subject starts globally linked), and this
    // query is not otherwise tenant-filtered — unscoped, it returns OTHER
    // tenants' role rules, and the loop below would then write subject-level
    // rules for foreign roleIds stamped with this tenant's tenantId. Inert,
    // because loadRoleRules resolves by roleId, but junk rows in this tenant's
    // scope, and they inflate the `materializedRules` count the UI reports back
    // as "N grants preserved". The globals must stay in: the four preset roles'
    // rules live there and genuinely need materializing.
    const rules = await tx.rbacRoleRule.findMany({
        where: {
            moduleId: { in: [fromModuleId, toModuleId] },
            OR: [{ tenantId }, { tenantId: null }],
        },
        select: { roleId: true, actionId: true, moduleId: true, conditions: true, inverted: true, reason: true },
    });

    const destination = new Set(
        rules.filter((r) => r.moduleId === toModuleId).map((r) => `${r.roleId}::${r.actionId}`)
    );

    // Redundancy is judged against the destination's UNCONDITIONAL grants only.
    // A conditional module rule does not subsume a subject-level rule, so it
    // must not license deleting one.
    const reaped = await reapRedundantSubjectGrants(tx, {
        tenantId,
        subjectId,
        covered: new Set(
            rules
                .filter((r) => r.moduleId === toModuleId && !r.inverted && r.conditions == null)
                .map((r) => `${r.roleId}::${r.actionId}`)
        ),
    });

    const toCreate = rules
        .filter((r) => r.moduleId === fromModuleId && !destination.has(`${r.roleId}::${r.actionId}`))
        .map((r) => ({
            tenantId,
            roleId: r.roleId,
            actionId: r.actionId,
            moduleId: null,
            subjectId,
            conditions: r.conditions ?? undefined,
            inverted: r.inverted,
            reason: r.reason ?? 'Preserved when this area moved to another module',
            createdBy,
        }));

    if (toCreate.length === 0) return { materialized: 0, reaped };
    // skipDuplicates: the (roleId, actionId, moduleId, subjectId) unique index
    // makes a re-run of the same remap a no-op rather than a crash.
    await tx.rbacRoleRule.createMany({ data: toCreate, skipDuplicates: true });
    return { materialized: toCreate.length, reaped };
}

/**
 * The other half of materializeSubjectGrants — deleting what a return trip made
 * redundant.
 *
 * ── WHY THIS IS NEEDED ──────────────────────────────────────────────────────
 * Moving subject S out of module A materializes a subject-level rule for every
 * role that held (A, verb). Moving S BACK into A materializes nothing (the
 * module rules never left A, so there is nothing at the origin to copy) — and
 * the outbound leg's rules survive the round trip permanently.
 *
 * Those leftovers are not inert. rule-compiler.ts step 3 gives a subject-level
 * rule PRECEDENCE over the module-level rule it duplicates, so the leftover
 * becomes the operative grant. The roles grid writes only module-level rules
 * (role-rule-sync.ts, by design), so unticking the cell deletes the module rule
 * and leaves the leftover granting — a live permission with no checkbox
 * anywhere that can revoke it. That is exactly how a role kept `create Agent`
 * after AI Ops/Create was unticked.
 *
 * ── WHAT IT WILL NOT TOUCH ──────────────────────────────────────────────────
 * Only rules that are REDUNDANT: same (role, action) as an unconditional
 * module-level grant on the destination, themselves unconditional and not
 * inverted. A conditional rule NARROWS the module grant and an inverted one
 * REVERSES it; neither repeats it, and deleting either would widen permissions.
 * A rule for a verb the destination does not grant is the genuine preservation
 * materializeSubjectGrants exists to create, and is likewise kept.
 */
async function reapRedundantSubjectGrants(
    tx: RbacTransaction,
    opts: {
        tenantId: string;
        subjectId: string;
        /**
         * (roleId::actionId) the destination module grants UNCONDITIONALLY.
         * Supplied by the caller, which has already read these rows.
         */
        covered: Set<string>;
    }
): Promise<number> {
    const { tenantId, subjectId, covered } = opts;
    if (covered.size === 0) return 0;

    // Same tenant-plus-globals scope as materializeSubjectGrants, and for the
    // same reason: unscoped, this reads other tenants' rows.
    // `conditions` is `Json?`, and Prisma reads `{ equals: null }` on a Json
    // column as the JSON VALUE null rather than SQL NULL — a filter that
    // matches nothing here. Unconditional-ness is therefore settled in JS,
    // which is also where the reader can see it.
    const candidates = await tx.rbacRoleRule.findMany({
        where: {
            subjectId,
            moduleId: null,
            inverted: false,
            OR: [{ tenantId }, { tenantId: null }],
        },
        select: { id: true, roleId: true, actionId: true, conditions: true },
    });

    const ids = candidates
        .filter((r) => r.conditions == null && covered.has(`${r.roleId}::${r.actionId}`))
        .map((r) => r.id);
    if (ids.length === 0) return 0;

    await tx.rbacRoleRule.deleteMany({ where: { id: { in: ids } } });
    return ids.length;
}

/**
 * Applies the grantable-cell set, and deals with the cells being REMOVED.
 *
 * `grantable: false` does not stop an existing rule compiling — it only trims
 * `manage` expansion. So a removed cell whose rules stay behind is a permission
 * in force with no checkbox: invisible and unrevokable from the grid. Removing
 * such a cell therefore requires `force`, and then deletes the rules.
 */
async function applyModuleActions(
    tx: RbacTransaction,
    opts: {
        tenantId: string;
        moduleId: string;
        moduleKey: string;
        actionIdByKey: Map<string, string>;
        actionKeys: string[];
        force: boolean;
    }
): Promise<number> {
    const { tenantId, moduleId, moduleKey, actionIdByKey, actionKeys, force } = opts;

    const desired = new Set(
        actionKeys.map((key) => {
            const id = actionIdByKey.get(key);
            if (!id) throw new Error(`Unknown permission '${key}'.`);
            return id;
        })
    );

    // Same scope as materializeSubjectGrants, and for the same reason: these
    // queries are keyed only on moduleId, so without it they would read and
    // COUNT other tenants' rows. Safe today only because this function is never
    // reached with a global moduleId — an implicit precondition is a poor guard
    // when the cost of the explicit one is a single clause.
    const scope = { OR: [{ tenantId }, { tenantId: null }] };

    const existing = await tx.rbacModuleAction.findMany({
        where: { moduleId, ...scope },
        select: { id: true, actionId: true },
    });
    const existingIds = new Set(existing.map((row) => row.actionId));

    const removed = existing.filter((row) => !desired.has(row.actionId));
    let revoked = 0;
    if (removed.length > 0) {
        const grants = await tx.rbacRoleRule.count({
            where: { moduleId, actionId: { in: removed.map((r) => r.actionId) }, ...scope },
        });
        if (grants > 0 && !force) {
            throw new RegistryInUseError(
                `Removing those permissions from '${moduleKey}' would leave ${grants} role(s) holding a grant ` +
                    `with no checkbox to revoke it. Confirm to revoke them as part of this change.`
            );
        }
        if (grants > 0) {
            await tx.rbacRoleRule.deleteMany({
                where: { moduleId, actionId: { in: removed.map((r) => r.actionId) }, ...scope },
            });
            revoked = grants;
        }
        await tx.rbacModuleAction.deleteMany({ where: { id: { in: removed.map((r) => r.id) } } });
    }

    const added = [...desired].filter((actionId) => !existingIds.has(actionId));
    if (added.length > 0) {
        await tx.rbacModuleAction.createMany({
            data: added.map((actionId) => ({ tenantId, moduleId, actionId, grantable: true })),
            skipDuplicates: true,
        });
    }

    return revoked;
}

async function applyModuleSubjects(
    tx: RbacTransaction,
    opts: {
        tenantId: string;
        moduleId: string;
        subjectIdByKey: Map<string, string>;
        subjectKeys: string[];
        createdBy: string;
    }
): Promise<{ materialized: number; reaped: number }> {
    const { tenantId, moduleId, subjectIdByKey, subjectKeys, createdBy } = opts;
    let materialized = 0;
    let reaped = 0;

    const desired = subjectKeys.map((key) => {
        const id = subjectIdByKey.get(key);
        if (!id) throw new Error(`Unknown area '${key}'.`);
        return id;
    });

    for (const subjectId of desired) {
        // @@unique([tenantId, subjectId]) permits ONE link per (tenant, subject)
        // pair — but a subject with no TENANT-local link may still have a
        // GLOBAL one (tenantId null), which is how every seeded system subject
        // starts out. Look for this tenant's own link first, and only fall back
        // to the global link to learn where the subject currently is. Updating
        // that global row directly would move the subject for EVERY tenant, so
        // this tenant gets its own link instead.
        //
        // Copying is safe HERE, where copying a module or action row is not, and
        // the difference is what rules reference. A rule stores moduleId /
        // actionId / subjectId — never a link-row id — so a new link row orphans
        // nothing. Copying a module row, by contrast, gives it a new id that no
        // existing rule points at, and mergeByKey drops the shadowed original
        // from the snapshot, so every grant on it silently stops compiling.
        // That is why built-in module and permission rows are read-only.
        //
        // Each lookup is scoped to a single tenantId (this tenant's, or
        // explicitly null), so there is at most one candidate per query. The
        // resulting tenant/global pair is disambiguated for every reader by
        // mergeBySubjectId() in registry.ts — without it the compiler buckets
        // the subject under both modules and the remap never takes effect.
        const tenantLink = await tx.rbacSubjectModule.findFirst({
            where: { tenantId, subjectId },
            select: { id: true, moduleId: true },
        });
        const globalLink = tenantLink
            ? null
            : await tx.rbacSubjectModule.findFirst({
                  where: { tenantId: null, subjectId },
                  select: { id: true, moduleId: true },
              });
        const current = tenantLink ?? globalLink;
        if (current?.moduleId === moduleId) continue;

        if (current) {
            const outcome = await materializeSubjectGrants(tx, {
                tenantId,
                subjectId,
                fromModuleId: current.moduleId,
                toModuleId: moduleId,
                createdBy,
            });
            materialized += outcome.materialized;
            reaped += outcome.reaped;
        }

        if (tenantLink) {
            // This tenant already has its own override link — move it.
            await tx.rbacSubjectModule.update({ where: { id: tenantLink.id }, data: { moduleId } });
        } else {
            // No link existed, or only the global one did — either way this
            // tenant gets its OWN link. Creating (never updating) the global
            // row is what keeps this a copy, not a shared mutation; the
            // @@unique constraint is on (tenantId, subjectId), so a new row
            // scoped to this tenant never collides with the global one.
            await tx.rbacSubjectModule.create({ data: { tenantId, subjectId, moduleId } });
        }
    }

    // Subjects dropped from this module are NOT unmapped: a subject with no
    // module compiles to nothing, which fails closed and revokes access
    // silently. They stay put until another module claims them.
    return { materialized, reaped };
}

function validateModuleInput(input: ModuleInput): string {
    const key = input.key.trim();
    if (!MODULE_KEY_PATTERN.test(key)) {
        throw new Error(`'${key}' is not a valid module key — use letters and digits only, e.g. 'CostControl'.`);
    }
    if (!input.label.trim()) {
        throw new Error('A module needs a label — it cannot be blank or made of only whitespace.');
    }
    if (input.actionKeys.length === 0) {
        throw new Error('Select at least one permission for this module, or its column has nothing to grant.');
    }
    return key;
}

export async function createModule(actor: RbacActor, input: ModuleInput): Promise<ModuleWriteResult> {
    if (actor.tenantId === null) throw new SystemRowError('Global registry authoring is not available here.');
    const key = validateModuleInput(input);
    const tenantId = actor.tenantId;

    const registry = await loadAdminRegistry(tenantId);
    if (registry.modules.some((m) => m.key === key)) {
        throw new Error(`A module named '${key}' already exists.`);
    }
    const actionIdByKey = new Map(registry.actions.map((a) => [a.key, a.id]));
    const subjectIdByKey = new Map(registry.subjects.map((s) => [s.key, s.id]));

    return runRbacMutation(
        { actor, entityType: 'module', entityId: key, operation: 'create', after: input },
        async (tx) => {
            const module = await tx.rbacModule.create({
                data: {
                    tenantId,
                    key,
                    label: input.label.trim(),
                    description: input.description ?? null,
                    icon: input.icon ?? null,
                    navPath: input.navPath ?? null,
                    sortOrder: input.sortOrder ?? 100,
                    enabled: input.enabled ?? true,
                    isSystem: false,
                    createdBy: actor.email,
                },
                select: { id: true },
            });

            const revokedRules = await applyModuleActions(tx, {
                tenantId,
                moduleId: module.id,
                moduleKey: key,
                actionIdByKey,
                actionKeys: input.actionKeys,
                force: true, // a new module has no cells to remove
            });
            const subjects = await applyModuleSubjects(tx, {
                tenantId,
                moduleId: module.id,
                subjectIdByKey,
                subjectKeys: input.subjectKeys,
                createdBy: actor.email,
            });

            return {
                id: module.id,
                materializedRules: subjects.materialized,
                reapedRules: subjects.reaped,
                revokedRules,
            };
        }
    );
}

/**
 * Edits a module the tenant owns. A BUILT-IN module (`tenantId IS NULL`) is
 * refused for a tenant actor and editable only by a SuperAdmin, mirroring
 * updateAction — see the comment on that refusal for why an override cannot
 * substitute.
 *
 * The two access-removing operations live here, and both are made loud rather
 * than silent: removing a grantable cell that still has grants needs `force`
 * and then deletes exactly those rules, and moving a subject between modules
 * materializes an explicit subject-level rule for every role that would
 * otherwise lose it.
 */
export async function updateModule(
    actor: RbacActor,
    moduleId: string,
    input: ModuleInput,
    opts: { force?: boolean; reason?: string } = {}
): Promise<ModuleWriteResult> {
    const key = validateModuleInput(input);
    const prisma = getPrismaClient();
    const before = await prisma.rbacModule.findUnique({ where: { id: moduleId } });
    if (!before) throw new Error('Module not found');

    const patch: Record<string, unknown> = {
        label: input.label.trim(),
        description: input.description ?? null,
        sortOrder: input.sortOrder ?? before.sortOrder,
    };

    if (before.tenantId === null) {
        if (actor.tenantId === null) {
            // SuperAdmin editing the shared row directly IS global system-row
            // authoring — the path assertTenantScoped's contract reserves for it.
            return runRbacMutation(
                { actor, entityType: 'module', entityId: moduleId, operation: 'update', before, after: patch, reason: opts.reason },
                async (tx) => {
                    await tx.rbacModule.update({ where: { id: moduleId }, data: patch });
                    return { id: moduleId, materializedRules: 0, reapedRules: 0, revokedRules: 0 };
                }
            );
        }

        // Refused for the reason spelled out on updateAction: the compiler
        // resolves grants by row ID, so an override — which necessarily has a
        // new id — orphans every rule that referenced the built-in module, and
        // mergeByKey() removes the shadowed row from the snapshot so the miss is
        // silent (rule-compiler.ts:305-313, 'unknown-module'). A relabel would
        // have revoked the module for every role in the tenant.
        //
        // Creating a tenant's OWN modules, remapping subjects into them, and
        // choosing their grantable verbs are all unaffected.
        throw new SystemRowError(
            `'${before.key}' is a built-in module and cannot be edited. Create your own module instead.`
        );
    }

    assertTenantScoped(actor.tenantId, before.tenantId);
    patch.key = key;
    patch.icon = input.icon ?? null;
    patch.navPath = input.navPath ?? null;
    patch.enabled = input.enabled ?? before.enabled;

    // A SuperAdmin editing a specific tenant's row writes its action/subject
    // links under THAT tenant, never global — the module itself already
    // belongs to it, and assertTenantScoped() lets a null actor through
    // exactly for this case.
    const tenantId = actor.tenantId ?? before.tenantId;

    const registry = await loadAdminRegistry(tenantId);
    const actionIdByKey = new Map(registry.actions.map((a) => [a.key, a.id]));
    const subjectIdByKey = new Map(registry.subjects.map((s) => [s.key, s.id]));

    return runRbacMutation(
        {
            actor,
            entityType: 'module',
            entityId: moduleId,
            operation: 'update',
            before,
            after: input,
            reason: opts.reason,
            // A remap is a permission-preserving migration, not an ordinary
            // edit, and deserves its own name in the ledger.
            eventType: input.subjectKeys.length > 0 ? 'rbac.subject.remapped' : undefined,
        },
        async (tx) => {
            await tx.rbacModule.update({ where: { id: moduleId }, data: patch });
            const revokedRules = await applyModuleActions(tx, {
                tenantId,
                moduleId,
                moduleKey: key,
                actionIdByKey,
                actionKeys: input.actionKeys,
                force: opts.force ?? false,
            });
            const subjects = await applyModuleSubjects(tx, {
                tenantId,
                moduleId,
                subjectIdByKey,
                subjectKeys: input.subjectKeys,
                createdBy: actor.email,
            });
            return {
                id: moduleId,
                materializedRules: subjects.materialized,
                reapedRules: subjects.reaped,
                revokedRules,
            };
        }
    );
}

export async function deleteModule(actor: RbacActor, moduleId: string, reason?: string): Promise<void> {
    const prisma = getPrismaClient();
    const before = await prisma.rbacModule.findUnique({ where: { id: moduleId } });
    if (!before) throw new Error('Module not found');
    if (before.tenantId === null) {
        throw new SystemRowError(
            `'${before.key}' is a system module and cannot be deleted. Disable it instead — the compiler ` +
                `contributes nothing for a disabled module, so its grants stop applying without being destroyed.`
        );
    }
    assertTenantScoped(actor.tenantId, before.tenantId);

    await runRbacMutation(
        { actor, entityType: 'module', entityId: moduleId, operation: 'delete', before, reason },
        async (tx) => {
            // A subject with no module compiles to nothing, so deleting a module
            // that still covers areas revokes them silently. Refuse; make the
            // operator move them somewhere explicit first.
            const covered = await tx.rbacSubjectModule.count({ where: { moduleId } });
            if (covered > 0) {
                throw new RegistryInUseError(
                    `'${before.key}' still covers ${covered} area(s). Move them to another module first, or they ` +
                        `would stop being reachable by any role.`
                );
            }
            const grants = await tx.rbacRoleRule.count({ where: { moduleId } });
            if (grants > 0) {
                throw new RegistryInUseError(
                    `'${before.key}' is granted by ${grants} rule(s). Untick it in those roles first, or disable ` +
                        `the module to suspend it without destroying the grants.`
                );
            }
            await tx.rbacModule.delete({ where: { id: moduleId } });
        }
    );
}
