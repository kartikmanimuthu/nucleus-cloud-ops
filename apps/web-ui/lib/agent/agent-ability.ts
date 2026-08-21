/**
 * Resolves the ability the agent runs UNDER (Workstream H, Gate 4).
 *
 * The agent is not a principal of its own: it acts as the user who started the
 * run, so its tool set must be compiled from that user's role, not from an
 * agent-service identity. This is the non-request-scoped counterpart to
 * getAbilityForSession() — a run may outlive the HTTP request that started it
 * (scheduled tasks, background executor graphs), so the principal is rebuilt from
 * stored ids rather than read off a session.
 *
 * Imports are dynamic on purpose: model-factory.ts is pulled into every agent
 * graph, and this path drags in next-auth + Prisma. Loading it only when a run
 * actually needs a gate keeps that off the import graph of code (and tests) that
 * never gates.
 */

import type { AbilityPrincipal, AppAbility } from '@nucleus/rbac';

export interface AgentAbility {
    ability: AppAbility;
    principal: AbilityPrincipal;
    actionAliases: Record<string, string>;
}

/**
 * Compiles the ability for (tenantId, userId).
 *
 * Returns null when the pair cannot be resolved to a principal — an anonymous or
 * system-initiated run. The CALLER decides what that means; see the fail-open
 * note on assembleTools(), which keeps such runs at today's behaviour rather than
 * silently handing them an agent with no tools.
 *
 * Never throws: a registry read failure must not take down the chat endpoint.
 */
export async function resolveAgentAbility(
    tenantId: string | undefined,
    userId: string | undefined
): Promise<AgentAbility | null> {
    if (!tenantId || !userId) return null;

    try {
        const [{ buildPrincipalFor }, { getAbilityForPrincipal }, { getPrismaClient }] = await Promise.all([
            import('@/lib/rbac/session-ability'),
            import('@/lib/rbac/ability-cache'),
            import('@/lib/db/pg-config'),
        ]);

        // auth_users is a GLOBAL table (no tenantId), so it is read through the
        // unscoped client — the tenant extension would inject a predicate the
        // table has no column for. Nothing rbac* is touched here, so the bypass
        // guard in lib/rbac/registry-isolation.test.ts does not apply.
        const user = await getPrismaClient().authUser.findUnique({
            where: { id: userId },
            select: { email: true, isSuperAdmin: true },
        });

        const principal = await buildPrincipalFor({
            userId,
            email: user?.email ?? '',
            tenantId,
            // null -> resolveRole() reads user_tenant_roles rather than trusting a
            // caller-supplied role name. A run must not be able to name its own role.
            roleName: null,
            // A SuperAdmin's agent must not be narrower than the SuperAdmin. Read
            // from the row, never from anything the run could influence.
            isSuperAdmin: user?.isSuperAdmin === true,
        });
        if (!principal) return null;

        const { ability, dropped, actionAliases } = await getAbilityForPrincipal(principal);
        if (dropped.length > 0) {
            console.error('[AgentAbility] rules dropped during compilation:', JSON.stringify(dropped));
        }
        return { ability, principal, actionAliases };
    } catch (error) {
        console.error('[AgentAbility] failed to compile agent ability:', error);
        return null;
    }
}
