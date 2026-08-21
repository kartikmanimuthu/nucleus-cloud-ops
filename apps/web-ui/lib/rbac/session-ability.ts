/**
 * Builds the AbilityPrincipal for the current session and hands back a compiled
 * ability.
 *
 * Wrapped in React `cache()` so the several `authorize()` calls a single request
 * may make all share one principal resolution and one ability — the cache in
 * ability-cache.ts is process-wide, this one is request-wide.
 */

import { cache } from 'react';
import type { Session } from 'next-auth';

import { getAuthSession } from '@/lib/auth-session';
import { getPrismaClient, getTenantClient } from '@/lib/db/pg-config';
import type { AbilityPrincipal } from '@nucleus/rbac';

import { getAbilityForPrincipal, getRbacVersion, type CompiledAbility } from './ability-cache';
import { resolveRoleIdByName } from './registry';

export interface SessionAbility extends CompiledAbility {
    principal: AbilityPrincipal;
}

/**
 * Resolves the caller's role id.
 *
 * `UserTenantRole.roleId` is the FK, but historically roles were stored by NAME
 * only and the column is still nullable, so fall back to a name lookup and warn.
 * Mirrors the precedence in getCustomRolePermissions: a tenant's own custom role
 * beats a global preset of the same name.
 */
async function resolveRole(
    userId: string,
    tenantId: string,
    roleName: string | null
): Promise<{ roleId: string | null; roleName: string; level: number }> {
    const prisma = getPrismaClient();

    const membership = await prisma.userTenantRole.findUnique({
        where: { userId_tenantId: { userId, tenantId } },
        select: { roleId: true, role: true, customRole: { select: { id: true, name: true, level: true } } },
    });

    if (membership?.customRole) {
        return {
            roleId: membership.customRole.id,
            roleName: membership.customRole.name,
            level: membership.customRole.level,
        };
    }

    const name = membership?.role ?? roleName;
    if (!name) return { roleId: null, roleName: '', level: 0 };

    const roleId = await resolveRoleIdByName(tenantId, name);
    if (!roleId) {
        console.warn(`[rbac] no role row for '${name}' in tenant ${tenantId} — denying by default`);
        return { roleId: null, roleName: name, level: 0 };
    }

    if (!membership?.roleId) {
        console.warn(`[rbac] user ${userId} resolved role '${name}' by name; user_tenant_roles.roleId is null`);
    }

    const role = await prisma.customRole.findUnique({ where: { id: roleId }, select: { level: true } });
    return { roleId, roleName: name, level: role?.level ?? 0 };
}

/**
 * Principal attributes.
 *
 * Workstream C wires the builtins only. Workstream E adds the admin-assigned
 * rbac_user_attributes rows on top, which is what makes conditions like
 * `{"$var": "user.allowedAccountIds"}` resolvable.
 */
async function buildAttributes(principal: {
    userId: string;
    email: string;
    tenantId: string;
    roleId: string | null;
}): Promise<Record<string, unknown>> {
    const builtins: Record<string, unknown> = {
        'user.id': principal.userId,
        'user.email': principal.email,
        'user.tenantId': principal.tenantId,
    };
    if (principal.roleId) builtins['user.roleId'] = principal.roleId;

    // rbac_user_attributes has a NOT NULL tenantId, so unlike the registry it is
    // fully extension-scoped — the tenant client injects the predicate and no
    // bypass is warranted here.
    const db = getTenantClient(principal.tenantId);
    const assigned = await db.rbacUserAttribute.findMany({
        where: { userId: principal.userId },
        select: { key: true, value: true },
    });

    for (const row of assigned) {
        // Admin-assigned attributes are namespaced under user.* to match the
        // principal-attribute keys the registry declares.
        builtins[row.key.startsWith('user.') ? row.key : `user.${row.key}`] = row.value;
    }

    return builtins;
}

export interface PrincipalIdentity {
    userId: string;
    email: string;
    tenantId: string;
    /** The role NAME carried by the session/JWT; the id is resolved from it. */
    roleName: string | null;
    isSuperAdmin: boolean;
}

/**
 * Builds an AbilityPrincipal from raw identity fields.
 *
 * Exported so Layer 1 can use it: the middleware holds a NextAuth JWT, not a
 * server session, so it cannot go through getAbilityForSession().
 *
 * Cached per (tenant, user, RBAC version) because it performs two queries — the
 * role lookup and the attribute load — and Layer 1 runs on every request. The
 * version in the key means a role or attribute change still propagates within
 * the usual ~5s window.
 */
export async function buildPrincipalFor(identity: PrincipalIdentity): Promise<AbilityPrincipal | null> {
    if (!identity.userId || !identity.tenantId) return null;

    const version = await getRbacVersion(identity.tenantId);
    const key = `${identity.tenantId}:${identity.userId}:${version}`;

    const cached = principalCache.get(key);
    if (cached) return cached;

    const { roleId, roleName, level } = await resolveRole(
        identity.userId,
        identity.tenantId,
        identity.roleName
    );

    const principal: AbilityPrincipal = {
        userId: identity.userId,
        email: identity.email,
        tenantId: identity.tenantId,
        roleId,
        roleName,
        level,
        isSuperAdmin: identity.isSuperAdmin,
        attributes: await buildAttributes({
            userId: identity.userId,
            email: identity.email,
            tenantId: identity.tenantId,
            roleId,
        }),
    };

    if (principalCache.size > 500) principalCache.clear();
    principalCache.set(key, principal);
    return principal;
}

/** Version-keyed, so entries are immutable and stale keys simply fall out. */
const principalCache = new Map<string, AbilityPrincipal>();

async function buildPrincipal(session: Session): Promise<AbilityPrincipal | null> {
    const user = session.user;
    if (!user?.id) return null;

    // Tenantless sessions are redirected by middleware; if one reaches here it
    // gets no ability rather than a permissive default.
    if (!user.tenantId) return null;

    return buildPrincipalFor({
        userId: user.id,
        email: user.email ?? '',
        tenantId: user.tenantId,
        roleName: user.role ?? null,
        isSuperAdmin: user.isSuperAdmin === true,
    });
}

/**
 * The ability for the current request, or null when unauthenticated.
 * Request-scoped via React cache().
 */
export const getAbilityForSession = cache(async (): Promise<SessionAbility | null> => {
    const session = await getAuthSession();
    if (!session?.user) return null;

    const principal = await buildPrincipal(session);
    if (!principal) return null;

    const compiled = await getAbilityForPrincipal(principal);
    return { ...compiled, principal };
});
