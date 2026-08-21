/**
 * Projects a role's legacy permission blob onto `rbac_role_rules`.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * The roles UI writes `custom_roles.permissions`, a Record<Module, Action[]>.
 * The CASL engine reads `rbac_role_rules`. Until this module, nothing connected
 * them: `scripts/backfill-rbac.ts` seeded the rules once at migration time and
 * every subsequent edit landed only in the JSON. With DYNAMIC_ABAC_ENABLED on
 * that made the roles screen silently inert — it accepted changes that changed
 * nothing, which is worse than refusing them.
 *
 * ── WHAT IT DELIBERATELY DOES NOT TOUCH ─────────────────────────────────────
 * Only MODULE-level positive grants (`subjectId: null`, `inverted: false`) are
 * managed here, because that is exactly what the legacy blob can express.
 *
 * Subject-level rules and `cannot` rules cannot be represented in a
 * Record<Module, Action[]> at all. If this synced the full rule set it would
 * delete them on the next save from a UI that never knew they existed —
 * destroying finer-grained authorisation because someone toggled an unrelated
 * checkbox. They are left alone, and a future condition-aware editor owns them.
 *
 * ── ALIASES ─────────────────────────────────────────────────────────────────
 * The blob may carry aliased verbs (`execute`, `manage`, `validate`, …). They
 * are resolved to terminal actions through ACTION_MAP before lookup, matching
 * how authorize() resolves them at read time. An alias that resolves to several
 * actions (`manage`) expands to one rule each.
 */

import { ACTION_MAP, type Action, type Module, type PermissionSet } from './types';
import type { RbacTransaction } from './registry-service';

export interface SyncResult {
    created: number;
    deleted: number;
    /** Keys in the blob with no matching registry row — reported, never guessed. */
    skipped: string[];
}

/** Expand a blob verb into the terminal action key(s) the registry stores. */
function terminalActions(verb: string): string[] {
    const mapped = ACTION_MAP[verb as Action];
    if (!mapped) return [verb];
    return Array.isArray(mapped) ? [...mapped] : [mapped];
}

/**
 * Make `rbac_role_rules` match `permissions` for one role.
 *
 * Runs inside the caller's transaction so the rule write, the lockout check, the
 * ledger append and the version bump commit together — a partial sync would
 * leave the engine disagreeing with the screen that produced it.
 */
export async function syncRoleRules(
    tx: RbacTransaction,
    opts: {
        roleId: string;
        /** Owning tenant; null for a global preset. */
        tenantId: string | null;
        permissions: PermissionSet;
        createdBy: string;
    }
): Promise<SyncResult> {
    const { roleId, tenantId, permissions, createdBy } = opts;
    const skipped: string[] = [];

    // Registry rows visible to this tenant: its own overrides plus the globals.
    //
    // `OR: [{ tenantId }, { tenantId: null }]` rather than `in: [tenantId, null]`
    // — Prisma rejects a null inside `in` on a String field ("Expected
    // ListStringFieldRefInput or Null, provided (String, Null)"). This matches
    // registry.ts's globalOrTenant() helper, which is the established idiom here.
    const scope = tenantId === null ? { tenantId: null } : { OR: [{ tenantId }, { tenantId: null }] };

    const [modules, actions] = await Promise.all([
        tx.rbacModule.findMany({
            where: { ...scope, enabled: true },
            select: { id: true, key: true, tenantId: true },
        }),
        tx.rbacAction.findMany({
            where: scope,
            select: { id: true, key: true, tenantId: true },
        }),
    ]);

    /**
     * A tenant override of a key must beat the global row of the same key.
     *
     * Resolved HERE rather than via `orderBy: { tenantId: 'desc' }` because in
     * Postgres a DESC sort defaults to NULLS FIRST — so the global row (tenantId
     * null) arrives first and "take the first match" picks exactly backwards.
     * Verified against this database. Same precedence as registry.ts's
     * mergeByKey(): a tenant-local row shadows the global row of that key.
     */
    function indexByKey(rows: { id: string; key: string; tenantId: string | null }[]): Map<string, string> {
        const byKey = new Map<string, { id: string; tenantId: string | null }>();
        for (const row of rows) {
            const existing = byKey.get(row.key);
            if (!existing || (existing.tenantId === null && row.tenantId !== null)) {
                byKey.set(row.key, row);
            }
        }
        return new Map([...byKey].map(([key, row]) => [key, row.id]));
    }

    const moduleIdByKey = indexByKey(modules);
    const actionIdByKey = indexByKey(actions);

    // ── desired state ────────────────────────────────────────────────────────
    const desired = new Set<string>(); // `${moduleId}::${actionId}`

    for (const [moduleKey, verbs] of Object.entries(permissions ?? {})) {
        const moduleId = moduleIdByKey.get(moduleKey);
        if (!moduleId) {
            skipped.push(`module '${moduleKey}'`);
            continue;
        }
        for (const verb of (verbs ?? []) as Action[]) {
            for (const actionKey of terminalActions(verb)) {
                const actionId = actionIdByKey.get(actionKey);
                if (!actionId) {
                    skipped.push(`action '${actionKey}'`);
                    continue;
                }
                desired.add(`${moduleId}::${actionId}`);
            }
        }
    }

    // ── current state, module-level positive grants only ─────────────────────
    const existing = await tx.rbacRoleRule.findMany({
        where: { roleId, subjectId: null, inverted: false },
        select: { id: true, moduleId: true, actionId: true },
    });

    const existingByKey = new Map<string, string>(); // key -> rule id
    for (const rule of existing) {
        if (!rule.moduleId) continue; // defensive: a null-module positive rule is not ours
        existingByKey.set(`${rule.moduleId}::${rule.actionId}`, rule.id);
    }

    // ── diff ─────────────────────────────────────────────────────────────────
    const toCreate = [...desired].filter((k) => !existingByKey.has(k));
    const toDelete = [...existingByKey.entries()].filter(([k]) => !desired.has(k)).map(([, id]) => id);

    if (toCreate.length > 0) {
        await tx.rbacRoleRule.createMany({
            data: toCreate.map((key) => {
                const [moduleId, actionId] = key.split('::');
                return { tenantId, roleId, actionId, moduleId, createdBy };
            }),
        });
    }

    if (toDelete.length > 0) {
        // Deleting a revoked grant is the whole point — without it, unticking a
        // box in the UI would leave the permission live in the engine.
        await tx.rbacRoleRule.deleteMany({ where: { id: { in: toDelete } } });
    }

    return { created: toCreate.length, deleted: toDelete.length, skipped };
}
