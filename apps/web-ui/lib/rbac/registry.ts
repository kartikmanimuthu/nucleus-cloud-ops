/**
 * Registry READS — the one deliberate exception to the tenant-client rule.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ WHY THIS FILE USES getPrismaClient() AND NOT getTenantClient()           │
 * │                                                                          │
 * │ The RBAC registry intentionally holds GLOBAL rows with `tenantId IS NULL`│
 * │ — the system modules, actions and subjects seeded by the migration. The  │
 * │ tenant extension in lib/db/pg-config.ts injects `WHERE tenant_id = $1`, │
 * │ and in SQL that predicate EXCLUDES NULLs. Routing registry reads through │
 * │ getTenantClient() would therefore return zero system rows, the compiler  │
 * │ would find no subjects to resolve against, and every authorization check │
 * │ would fail closed. The app would deny everything, for everyone.          │
 * │                                                                          │
 * │ So reads here use the unscoped client with an EXPLICIT                   │
 * │     where: { OR: [{ tenantId }, { tenantId: null }] }                    │
 * │ on every single query. Tenant-local rows override global rows sharing a  │
 * │ key (see mergeByKey below).                                              │
 * │                                                                          │
 * │ Registry WRITES are NOT here. They go through getTenantClient() in       │
 * │ registry-service.ts, so a tenant can never author a global row.          │
 * │                                                                          │
 * │ This exception is confined to this file and asserted by                  │
 * │ registry-isolation.test.ts, which fails CI if any other module reaches   │
 * │ for getPrismaClient() while touching an rbac* model.                     │
 * │                                                                          │
 * │ See section 6.7 of the Dynamic ABAC plan.                                │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

import { getPrismaClient } from '@/lib/db/pg-config';
import type {
    RbacActionRow,
    RbacModuleActionRow,
    RbacModuleRow,
    RbacPrincipalAttributeRow,
    RbacRoleRuleRow,
    RbacSubjectAttributeRow,
    RbacSubjectModuleRow,
    RbacSubjectRow,
    RegistrySnapshot,
} from '@nucleus/rbac';

/** Matches a global row or a row belonging to this tenant, and nothing else. */
function globalOrTenant(tenantId: string) {
    return { OR: [{ tenantId }, { tenantId: null }] };
}

/**
 * Tenant-local rows shadow global rows that share a key. Ordering is explicit
 * rather than relying on query order, so the precedence is a property of this
 * function and not of the database's row layout.
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
 * Same precedence as mergeByKey, keyed on subjectId instead of key: a
 * subject-module link belonging to this tenant shadows the global link for
 * the same subject.
 *
 * subjectModules is the one snapshot list that was passed through RAW — every
 * other list (modules/actions/subjects) goes through mergeByKey. Left
 * unmerged, a remap (create a tenant-local link) leaves the global link in
 * place, and rule-compiler.ts buckets the subject under BOTH modules with no
 * orderBy on either fetch to break the tie: the old module's expansion never
 * loses the subject, and moduleIdBySubjectId becomes last-write-wins between
 * requests. @@unique([tenantId, subjectId]) caps this at one global row plus
 * one this-tenant row per subject, so — like mergeByKey — the outcome does not
 * depend on which of the two the loop sees first.
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

/**
 * Loads the full registry for a tenant: global rows plus that tenant's own,
 * merged. Callers should treat the result as immutable and cache it under the
 * RBAC version (see ability-cache.ts) rather than calling this per request.
 */
export async function loadRegistrySnapshot(tenantId: string): Promise<RegistrySnapshot> {
    const prisma = getPrismaClient();
    const scope = globalOrTenant(tenantId);

    const [modules, actions, subjects, subjectModules, moduleActions, subjectAttributes, principalAttributes] =
        await Promise.all([
            prisma.rbacModule.findMany({ where: scope, orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }] }),
            prisma.rbacAction.findMany({ where: scope, orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }] }),
            prisma.rbacSubject.findMany({ where: scope, orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }] }),
            prisma.rbacSubjectModule.findMany({ where: scope }),
            prisma.rbacModuleAction.findMany({ where: scope }),
            prisma.rbacSubjectAttribute.findMany({ where: scope }),
            prisma.rbacPrincipalAttribute.findMany({ where: scope }),
        ]);

    return {
        tenantId,
        modules: mergeByKey(modules as RbacModuleRow[]),
        actions: mergeByKey(actions as RbacActionRow[]),
        subjects: mergeByKey(subjects as RbacSubjectRow[]),
        subjectModules: mergeBySubjectId(subjectModules as RbacSubjectModuleRow[]),
        moduleActions: moduleActions as RbacModuleActionRow[],
        subjectAttributes: subjectAttributes as RbacSubjectAttributeRow[],
        principalAttributes: principalAttributes as RbacPrincipalAttributeRow[],
    };
}

/**
 * Principal-attribute definitions that may be ASSIGNED to a user (source='user').
 * Builtins are excluded because they come from the session, not from a row.
 */
export async function loadAssignablePrincipalAttributes(tenantId: string) {
    const prisma = getPrismaClient();
    return prisma.rbacPrincipalAttribute.findMany({
        where: { source: 'user', ...globalOrTenant(tenantId) },
        select: { key: true, label: true, valueType: true },
        orderBy: { key: 'asc' },
    });
}

/**
 * Route overrides for Layer 1, ordered by the resolution precedence the
 * middleware relies on (sortOrder asc, first match wins).
 */
export async function loadRoutePermissions(tenantId: string) {
    const prisma = getPrismaClient();
    return prisma.rbacRoutePermission.findMany({
        where: globalOrTenant(tenantId),
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        select: {
            method: true,
            pathPattern: true,
            actionKey: true,
            mode: true,
            enforced: true,
            reason: true,
            subject: { select: { key: true } },
        },
    });
}

/**
 * The grants held by one role. Rules are per-role, not per-tenant-wide, which is
 * why they load separately from the snapshot and cache under a different key.
 */
export async function loadRoleRules(tenantId: string, roleId: string): Promise<RbacRoleRuleRow[]> {
    const prisma = getPrismaClient();
    const rules = await prisma.rbacRoleRule.findMany({
        where: { roleId, ...globalOrTenant(tenantId) },
        orderBy: { id: 'asc' }, // deterministic: the compiler must not depend on row order
    });
    return rules as RbacRoleRuleRow[];
}

/**
 * Resolves a role by name for the legacy path where `UserTenantRole.roleId` is
 * null and only the role NAME was ever stored. Mirrors getCustomRolePermissions'
 * precedence: a tenant's own custom role wins over a global preset of the same name.
 */
export async function resolveRoleIdByName(tenantId: string, roleName: string): Promise<string | null> {
    const prisma = getPrismaClient();
    const role = await prisma.customRole.findFirst({
        where: {
            OR: [
                { tenantId, name: roleName, type: 'custom' },
                { tenantId: null, name: roleName, type: 'preset' },
            ],
        },
        orderBy: { type: 'asc' }, // 'custom' sorts before 'preset'
        select: { id: true },
    });
    return role?.id ?? null;
}

/**
 * Global-only (tenantId IS NULL) subject/module/link rows for the build-time
 * subject-coverage check (scripts/assert-subject-coverage.ts). That check
 * compares the system-seeded registry against the code-level SUBJECT_TO_MODULE
 * map — a different question from "what should this tenant see"
 * (loadRegistrySnapshot), so it wants the raw global rows, unmerged with any
 * tenant override.
 */
export async function loadGlobalSubjectCoverageRows(): Promise<{
    subjects: RbacSubjectRow[];
    subjectModules: RbacSubjectModuleRow[];
    modules: RbacModuleRow[];
}> {
    const prisma = getPrismaClient();
    const [subjects, subjectModules, modules] = await Promise.all([
        prisma.rbacSubject.findMany({ where: { tenantId: null } }),
        prisma.rbacSubjectModule.findMany({ where: { tenantId: null } }),
        prisma.rbacModule.findMany({ where: { tenantId: null } }),
    ]);

    return {
        subjects: subjects as RbacSubjectRow[],
        subjectModules: subjectModules as RbacSubjectModuleRow[],
        modules: modules as RbacModuleRow[],
    };
}

/**
 * `${globalVersion}.${tenantVersion}` — the cache-key suffix under which compiled
 * rules and abilities are stored. Bumping either half makes every stale key
 * unreachable without clearing anything.
 */
export async function readRbacVersion(tenantId: string): Promise<string> {
    const prisma = getPrismaClient();
    const [global, tenant] = await Promise.all([
        prisma.rbacGlobalVersion.findUnique({ where: { id: 1 }, select: { version: true } }),
        prisma.tenant.findUnique({ where: { id: tenantId }, select: { rbacVersion: true } }),
    ]);
    return `${global?.version ?? 0}.${tenant?.rbacVersion ?? 0}`;
}
