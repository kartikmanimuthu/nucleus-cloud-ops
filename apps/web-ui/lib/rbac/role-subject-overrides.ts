/**
 * Projects the matrix's SUBJECT-level overrides onto `rbac_role_rules`.
 *
 * ── HOW THIS DIFFERS FROM role-rule-sync.ts ─────────────────────────────────
 * syncRoleRules owns MODULE-level positive grants, because that is all
 * `Record<Module, Action[]>` can express. It explicitly refuses to touch subject
 * rules so that finer-grained authorisation is not destroyed by someone ticking
 * an unrelated checkbox.
 *
 * This function owns the next level down, and inherits the same discipline with
 * a narrower boundary:
 *
 *     subjectId IS NOT NULL  AND  conditions IS NULL  AND  fields = '{}'
 *
 * A subject rule carrying conditions or a field list belongs to the ABAC layer,
 * which has no authoring UI. It survives a save untouched.
 *
 * The original safety property still holds — never delete a grant the editor
 * cannot display — because the matrix renders every subject of every module, so
 * every editor-owned row is on screen when the operator presses Save.
 */

import { Prisma } from '@prisma/client';

import { ACTION_MAP, type Action } from './types';
import type { RbacTransaction } from './registry-service';

/** One subject's overrides. A verb in `deny` wins over the same verb in `grant`. */
export interface SubjectOverride {
    grant: string[];
    deny: string[];
}

export type SubjectOverrides = Record<string, SubjectOverride>;

export interface SubjectSyncResult {
    created: number;
    deleted: number;
    /** Keys with no matching registry row — reported, never guessed. */
    skipped: string[];
}

/** Expand a verb into the terminal action key(s) the registry stores. */
function terminalActions(verb: string): string[] {
    const mapped = ACTION_MAP[verb as Action];
    if (!mapped) return [verb];
    return Array.isArray(mapped) ? [...mapped] : [mapped];
}

/**
 * A tenant override of a key must beat the global row of the same key. Resolved
 * in JS, not with `orderBy: { tenantId: 'desc' }` — Postgres sorts DESC with
 * NULLS FIRST, so the global row arrives first and "take the first" picks
 * exactly backwards. Same idiom as role-rule-sync.ts and registry.ts.
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

export async function syncRoleSubjectOverrides(
    tx: RbacTransaction,
    opts: {
        roleId: string;
        /** Owning tenant; null for a global preset. */
        tenantId: string | null;
        overrides: SubjectOverrides;
        createdBy: string;
    }
): Promise<SubjectSyncResult> {
    const { roleId, tenantId, overrides, createdBy } = opts;
    const skipped: string[] = [];

    // See the Prisma nullable-String note in role-rule-sync.ts: a null inside
    // `in` is rejected at runtime on a String field.
    const scope = tenantId === null ? { tenantId: null } : { OR: [{ tenantId }, { tenantId: null }] };

    const [subjects, actions] = await Promise.all([
        tx.rbacSubject.findMany({ where: scope, select: { id: true, key: true, tenantId: true } }),
        tx.rbacAction.findMany({ where: scope, select: { id: true, key: true, tenantId: true } }),
    ]);

    const subjectIdByKey = indexByKey(subjects);
    const actionIdByKey = indexByKey(actions);

    // ── desired state ────────────────────────────────────────────────────────
    const desired = new Map<string, boolean>(); // `${subjectId}::${actionId}` -> inverted

    for (const [subjectKey, override] of Object.entries(overrides ?? {})) {
        const subjectId = subjectIdByKey.get(subjectKey);
        if (!subjectId) {
            skipped.push(`subject '${subjectKey}'`);
            continue;
        }
        // Grants first so a verb listed in BOTH resolves to deny. A cell cannot
        // produce that from the UI, but a hand-built payload can, and "the more
        // restrictive wins" is the only safe way to break the tie.
        for (const [verbs, inverted] of [
            [override.grant ?? [], false],
            [override.deny ?? [], true],
        ] as const) {
            for (const verb of verbs) {
                for (const actionKey of terminalActions(verb)) {
                    const actionId = actionIdByKey.get(actionKey);
                    if (!actionId) {
                        skipped.push(`action '${actionKey}'`);
                        continue;
                    }
                    desired.set(`${subjectId}::${actionId}`, inverted);
                }
            }
        }
    }

    // ── current state, editor-owned rows only ────────────────────────────────
    // `...scope` is load-bearing: a preset role's id is shared by every tenant,
    // so without it this reconciler's diff would pull in another tenant's rows
    // and DELETE them for being "not in this tenant's desired set". Same scope
    // shape as the subjects/actions reads above and loadRoleSubjectOverrides()'s
    // reader in registry-admin.ts.
    const existing = await tx.rbacRoleRule.findMany({
        where: {
            ...scope,
            roleId,
            subjectId: { not: null },
            // Prisma.DbNull, NOT null. On a nullable Json column a bare null is
            // read as "the JSON value null" and matches zero rows — the exact
            // bug lockout.ts documents at its `conditions` filter.
            conditions: { equals: Prisma.DbNull },
            fields: { equals: [] },
        },
        select: { id: true, subjectId: true, actionId: true, inverted: true },
    });

    const existingByKey = new Map<string, { id: string; inverted: boolean }>();
    for (const rule of existing) {
        if (!rule.subjectId) continue; // defensive; the WHERE already excludes these
        existingByKey.set(`${rule.subjectId}::${rule.actionId}`, { id: rule.id, inverted: rule.inverted });
    }

    // ── diff ─────────────────────────────────────────────────────────────────
    // A flip between grant and deny is a delete plus a create, not an update:
    // `inverted` is part of the row's identity for the unique constraint, and
    // recreating keeps this function a pure set-reconciler.
    const toCreate: { subjectId: string; actionId: string; inverted: boolean }[] = [];
    for (const [key, inverted] of desired) {
        const current = existingByKey.get(key);
        if (current && current.inverted === inverted) continue;
        const [subjectId, actionId] = key.split('::');
        toCreate.push({ subjectId, actionId, inverted });
    }

    const toDelete = [...existingByKey.entries()]
        .filter(([key, current]) => !desired.has(key) || desired.get(key) !== current.inverted)
        .map(([, current]) => current.id);

    // Delete first: a grant→deny flip on the same (subject, action) would
    // otherwise collide with the @@unique([roleId, actionId, moduleId, subjectId]).
    if (toDelete.length > 0) {
        await tx.rbacRoleRule.deleteMany({ where: { id: { in: toDelete } } });
    }

    if (toCreate.length > 0) {
        await tx.rbacRoleRule.createMany({
            data: toCreate.map((row) => ({
                roleId,
                tenantId,
                subjectId: row.subjectId,
                actionId: row.actionId,
                inverted: row.inverted,
                createdBy,
            })),
        });
    }

    return { created: toCreate.length, deleted: toDelete.length, skipped };
}
