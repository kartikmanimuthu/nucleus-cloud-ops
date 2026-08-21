/**
 * Registry READS for the admin screens.
 *
 * Uses getPrismaClient() with an explicit `OR: [{ tenantId }, { tenantId: null }]`
 * on every query, for the reason spelled out at the top of registry.ts: the
 * system rows have `tenantId IS NULL`, and the tenant extension's injected
 * `WHERE tenant_id = $1` excludes NULLs, so a scoped client returns none of
 * them. This file is listed alongside registry.ts in registry-isolation.test.ts.
 *
 * Kept separate from registry.ts because the shapes differ: the compiler wants
 * raw rows, the screens want rows joined to their links and annotated with the
 * rule counts that make a delete refusal truthful.
 *
 * Registry WRITES (verbs and modules) live in registry-admin-writes.ts, which
 * imports loadAdminRegistry() from here — kept apart so this file stays reads
 * + types as the writes half grows.
 */

import { Prisma } from '@prisma/client';

import { getPrismaClient } from '@/lib/db/pg-config';
import type { PermissionSet } from './types';
import type { SubjectOverrides } from './role-subject-overrides';

export interface AdminActionRow {
    id: string;
    key: string;
    label: string;
    description: string | null;
    aliasOfKey: string | null;
    isDangerous: boolean;
    sortOrder: number;
    isSystem: boolean;
    /** True for a system row the tenant may relabel but not re-key or delete. */
    isGlobal: boolean;
    /** Grants that would be destroyed by deleting this row. */
    ruleCount: number;
}

export interface AdminModuleRow {
    id: string;
    key: string;
    label: string;
    description: string | null;
    icon: string | null;
    navPath: string | null;
    sortOrder: number;
    enabled: boolean;
    isSystem: boolean;
    isGlobal: boolean;
    /** Verb keys with a grantable RbacModuleAction row — the grid's columns. */
    actionKeys: string[];
    /** Subject keys mapped to this module — what makes its grants enforceable. */
    subjectKeys: string[];
    ruleCount: number;
}

export interface AdminSubjectRow {
    id: string;
    key: string;
    label: string;
    kind: string;
    moduleKey: string | null;
    isSystem: boolean;
}

export interface AdminRegistry {
    modules: AdminModuleRow[];
    actions: AdminActionRow[];
    subjects: AdminSubjectRow[];
    /**
     * Total grantable cells. Passed to getAutoLevel() as the Owner ceiling so
     * adding modules does not inflate every role's level.
     */
    grantableCellCount: number;
}

function globalOrTenant(tenantId: string) {
    return { OR: [{ tenantId }, { tenantId: null }] };
}

/**
 * A tenant-local row shadows the global row of the same key. Resolved in JS,
 * not with `orderBy: { tenantId: 'desc' }` — Postgres sorts DESC with NULLS
 * FIRST, so "take the first match" picks exactly backwards.
 */
function mergeByKey<T extends { key: string; tenantId: string | null }>(rows: T[]): T[] {
    const byKey = new Map<string, T>();
    for (const row of rows) {
        const existing = byKey.get(row.key);
        if (!existing || (existing.tenantId === null && row.tenantId !== null)) {
            byKey.set(row.key, row);
        }
    }
    return [...byKey.values()];
}

/**
 * Same precedence, keyed on subjectId — the link tables have no `key`.
 *
 * A remap writes a TENANT-local subject-module link while the global link
 * survives (it must: mutating the global row would move the subject for every
 * tenant). Both then match this file's read scope, so without this merge the
 * subject lands in BOTH modules' `subjectKeys` and `moduleKeyBySubjectKey`
 * becomes last-write-wins over an unordered query — the Modules screen would
 * list a just-moved subject twice and the Subjects list would name an arbitrary
 * owner. loadRegistrySnapshot() in registry.ts applies the identical merge for
 * the compiler; this is the same fix for the admin reader.
 */
function mergeBySubjectId<T extends { subjectId: string; tenantId: string | null }>(rows: T[]): T[] {
    const bySubjectId = new Map<string, T>();
    for (const row of rows) {
        const existing = bySubjectId.get(row.subjectId);
        if (!existing || (existing.tenantId === null && row.tenantId !== null)) {
            bySubjectId.set(row.subjectId, row);
        }
    }
    return [...bySubjectId.values()];
}

export async function loadAdminRegistry(tenantId: string): Promise<AdminRegistry> {
    const prisma = getPrismaClient();
    const scope = globalOrTenant(tenantId);

    const [modules, actions, subjects, subjectModules, moduleActions, ruleCounts] = await Promise.all([
        prisma.rbacModule.findMany({ where: scope, orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }] }),
        prisma.rbacAction.findMany({ where: scope, orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }] }),
        prisma.rbacSubject.findMany({ where: scope, orderBy: { key: 'asc' } }),
        prisma.rbacSubjectModule.findMany({ where: scope }).then(mergeBySubjectId),
        prisma.rbacModuleAction.findMany({ where: scope }),
        // Counted across the tenant's roles AND the global presets, because a
        // preset rule is destroyed by a cascade just as a tenant rule is.
        prisma.rbacRoleRule.groupBy({
            by: ['moduleId', 'actionId'],
            where: scope,
            _count: { _all: true },
        }),
    ]);

    const visibleModules = mergeByKey(modules);
    const visibleActions = mergeByKey(actions);
    const visibleSubjects = mergeByKey(subjects);

    // Resolved from the RAW (pre-merge) arrays, not the visible/winning ones: a
    // tenant override and the global row it shadows share a key but have
    // DIFFERENT ids, and every child table below (rbac_role_rules,
    // rbac_module_actions, rbac_subject_modules) is fetched with the same
    // global-or-tenant scope, so its rows may legitimately reference either id
    // — most commonly the global preset roles' rules, which point at the global
    // module/action id and are never rewritten when a tenant creates an
    // override. A map built from only the visible rows would have no entry for
    // the shadowed id and silently drop everything that points at it. Keying
    // off the raw arrays means both the shadowed id and the winning id resolve
    // to the same merged key, so every aggregation below can bucket by KEY and
    // get a shadowed-id reference and a winning-id reference into the same
    // bucket.
    const actionKeyById = new Map(actions.map((a) => [a.id, a.key]));
    const subjectKeyById = new Map(subjects.map((s) => [s.id, s.key]));
    const moduleKeyById = new Map(modules.map((m) => [m.id, m.key]));

    // Counts are keyed by KEY, not id: a tenant override and the global row it
    // shadows are the same permission to a reader, and rules may point at either.
    // Per-CELL counts are deliberately not computed here: Task 4 needs them for a
    // confirmation prompt, and that must reflect the state the write will see, so
    // it counts inside its own transaction.
    const rulesByModuleKey = new Map<string, number>();
    const rulesByActionKey = new Map<string, number>();
    for (const row of ruleCounts) {
        const count = row._count._all;
        const moduleKey = row.moduleId ? moduleKeyById.get(row.moduleId) : undefined;
        const actionKey = actionKeyById.get(row.actionId);
        if (moduleKey) rulesByModuleKey.set(moduleKey, (rulesByModuleKey.get(moduleKey) ?? 0) + count);
        if (actionKey) rulesByActionKey.set(actionKey, (rulesByActionKey.get(actionKey) ?? 0) + count);
    }

    // Bucketed by module KEY, not the raw link.moduleId, for the same shadowed-id
    // reason as the rule counts above.
    const grantableByModuleKey = new Map<string, Set<string>>();
    for (const link of moduleActions) {
        if (!link.grantable) continue;
        const actionKey = actionKeyById.get(link.actionId);
        const moduleKey = moduleKeyById.get(link.moduleId);
        if (!actionKey || !moduleKey) continue;
        const bucket = grantableByModuleKey.get(moduleKey) ?? new Set<string>();
        bucket.add(actionKey);
        grantableByModuleKey.set(moduleKey, bucket);
    }

    // Both directions of the subject/module mapping are keyed by KEY for the
    // same reason: a subjectModule link may point at either the module's
    // shadowed id or its winning id.
    const subjectKeysByModuleKey = new Map<string, Set<string>>();
    const moduleKeyBySubjectKey = new Map<string, string>();
    for (const link of subjectModules) {
        const subjectKey = subjectKeyById.get(link.subjectId);
        const moduleKey = moduleKeyById.get(link.moduleId);
        if (!subjectKey || !moduleKey) continue;
        moduleKeyBySubjectKey.set(subjectKey, moduleKey);
        const bucket = subjectKeysByModuleKey.get(moduleKey) ?? new Set<string>();
        bucket.add(subjectKey);
        subjectKeysByModuleKey.set(moduleKey, bucket);
    }

    return {
        modules: visibleModules.map((m) => ({
            id: m.id,
            key: m.key,
            label: m.label,
            description: m.description,
            icon: m.icon,
            navPath: m.navPath,
            sortOrder: m.sortOrder,
            enabled: m.enabled,
            isSystem: m.isSystem,
            isGlobal: m.tenantId === null,
            actionKeys: [...(grantableByModuleKey.get(m.key) ?? [])].sort(),
            subjectKeys: [...(subjectKeysByModuleKey.get(m.key) ?? [])].sort(),
            ruleCount: rulesByModuleKey.get(m.key) ?? 0,
        })),
        actions: visibleActions.map((a) => ({
            id: a.id,
            key: a.key,
            label: a.label,
            description: a.description,
            aliasOfKey: a.aliasOfKey,
            isDangerous: a.isDangerous,
            sortOrder: a.sortOrder,
            isSystem: a.isSystem,
            isGlobal: a.tenantId === null,
            ruleCount: rulesByActionKey.get(a.key) ?? 0,
        })),
        subjects: visibleSubjects.map((s) => ({
            id: s.id,
            key: s.key,
            label: s.label,
            kind: s.kind,
            moduleKey: moduleKeyBySubjectKey.get(s.key) ?? null,
            isSystem: s.isSystem,
        })),
        grantableCellCount: [...grantableByModuleKey.values()].reduce((sum, set) => sum + set.size, 0),
    };
}

/**
 * CRUD first, in the order the roles grid renders its columns, then anything a
 * tenant has authored, alphabetically. Only affects display order.
 */
const VERB_ORDER = ['create', 'read', 'update', 'delete'];

function byVerbOrder(a: string, b: string): number {
    const ia = VERB_ORDER.indexOf(a);
    const ib = VERB_ORDER.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
}

/**
 * Module-level grants for a set of roles, read back out of `rbac_role_rules`.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────
 * The Roles screen renders a Record<Module, Action[]> summary per role. For a
 * CUSTOM role that blob is kept truthful by syncRoleRules() on every save, but
 * the four PRESETS are different: 20260730000000_dynamic_abac inserts them with
 * `permissions = '{}'::jsonb` ON PURPOSE and materialises their grants as rules
 * instead. Reading the blob therefore reported "No permissions" for Owner,
 * Admin, Member and Viewer on a database built by `migrate deploy` — which is
 * every deployed environment, since the entrypoint never runs the seed.
 *
 * ── WHAT IT READS, AND WHAT IT DELIBERATELY DOES NOT ────────────────────────
 * Exactly the mirror of what syncRoleRules() WRITES: module-level
 * (`subjectId: null`), positive (`inverted: false`) rules. Subject-level rules
 * and `cannot` rules cannot be expressed in a Record<Module, Action[]> at all,
 * so they are omitted rather than flattened into a shape that would misstate
 * them — the same reasoning role-rule-sync.ts gives for not managing them.
 * A role holding only subject-level grants therefore summarises as empty here;
 * that is the card's shape, not a lost grant.
 *
 * Verbs come back as the TERMINAL action keys the registry stores. Aliases were
 * already resolved through ACTION_MAP on the way in, matching how authorize()
 * resolves them at read time.
 *
 * @param tenantId Owning tenant, or null to read global rows only (the presets).
 * @returns roleId → PermissionSet. A role with no module-level rules is ABSENT
 *          from the map rather than present-and-empty, so a caller can tell
 *          "granted nothing" apart from "no rules exist for it at all".
 */
export async function loadRoleModuleGrants(
    roleIds: string[],
    tenantId: string | null
): Promise<Map<string, PermissionSet>> {
    if (roleIds.length === 0) return new Map();

    const prisma = getPrismaClient();
    // Preset rules are global (`tenantId IS NULL`); custom-role rules are
    // tenant-local. globalOrTenant() covers both when a tenant is known.
    const scope = tenantId === null ? { tenantId: null } : globalOrTenant(tenantId);

    const [rules, modules, actions] = await Promise.all([
        prisma.rbacRoleRule.findMany({
            where: { ...scope, roleId: { in: roleIds }, subjectId: null, inverted: false },
        }),
        prisma.rbacModule.findMany({ where: scope }),
        prisma.rbacAction.findMany({ where: scope }),
    ]);

    // Keyed off the RAW rows for the shadowed-id reason spelled out in
    // loadAdminRegistry(): a preset rule points at the GLOBAL module/action id
    // and is never rewritten when a tenant authors an override, so a map built
    // from only the winning rows would drop every preset grant on exactly the
    // tenants that have customised anything.
    const moduleKeyById = new Map(modules.map((m) => [m.id, m.key]));
    const actionKeyById = new Map(actions.map((a) => [a.id, a.key]));

    const byRole = new Map<string, Map<string, Set<string>>>();
    for (const rule of rules) {
        if (!rule.moduleId) continue;
        const moduleKey = moduleKeyById.get(rule.moduleId);
        const actionKey = actionKeyById.get(rule.actionId);
        // A rule pointing at a registry row this reader cannot see is skipped, not
        // guessed at — same posture as syncRoleRules()'s `skipped`.
        if (!moduleKey || !actionKey) continue;
        const modulesForRole = byRole.get(rule.roleId) ?? new Map<string, Set<string>>();
        const verbs = modulesForRole.get(moduleKey) ?? new Set<string>();
        verbs.add(actionKey);
        modulesForRole.set(moduleKey, verbs);
        byRole.set(rule.roleId, modulesForRole);
    }

    const out = new Map<string, PermissionSet>();
    for (const [roleId, moduleMap] of byRole) {
        const permissions: PermissionSet = {};
        for (const [moduleKey, verbs] of moduleMap) {
            permissions[moduleKey] = [...verbs].sort(byVerbOrder);
        }
        out.set(roleId, permissions);
    }
    return out;
}

/**
 * The subject-level overrides for a set of roles, keyed by role id.
 *
 * The exact inverse of syncRoleSubjectOverrides, and scoped identically —
 * `conditions IS NULL AND fields = '{}'` — so the editor round-trips its own
 * output and never displays an ABAC rule it has no way to edit.
 */
export async function loadRoleSubjectOverrides(
    roleIds: string[],
    tenantId: string | null
): Promise<Map<string, SubjectOverrides>> {
    if (roleIds.length === 0) return new Map();

    const prisma = getPrismaClient();
    const scope = tenantId === null ? { tenantId: null } : globalOrTenant(tenantId);

    const [rules, subjects, actions] = await Promise.all([
        prisma.rbacRoleRule.findMany({
            where: {
                ...scope,
                roleId: { in: roleIds },
                subjectId: { not: null },
                conditions: { equals: Prisma.DbNull },
                fields: { equals: [] },
            },
        }),
        prisma.rbacSubject.findMany({ where: scope }),
        prisma.rbacAction.findMany({ where: scope }),
    ]);

    // Keyed off the RAW rows for the shadowed-id reason loadRoleModuleGrants
    // spells out: a preset rule points at the GLOBAL row id and is never
    // rewritten when a tenant authors an override.
    const subjectKeyById = new Map(subjects.map((s) => [s.id, s.key]));
    const actionKeyById = new Map(actions.map((a) => [a.id, a.key]));

    const out = new Map<string, SubjectOverrides>();
    for (const rule of rules) {
        if (!rule.subjectId) continue;
        const subjectKey = subjectKeyById.get(rule.subjectId);
        const actionKey = actionKeyById.get(rule.actionId);
        // A rule naming a row this reader cannot see is skipped, not guessed at —
        // same posture as syncRoleRules()'s `skipped`.
        if (!subjectKey || !actionKey) continue;

        const forRole = out.get(rule.roleId) ?? {};
        const entry = forRole[subjectKey] ?? { grant: [], deny: [] };
        (rule.inverted ? entry.deny : entry.grant).push(actionKey);
        forRole[subjectKey] = entry;
        out.set(rule.roleId, forRole);
    }

    return out;
}

