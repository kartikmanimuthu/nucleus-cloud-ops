/**
 * Execution-time re-authorization of a scheduled agent task (Workstream H, Gate 4).
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ A SCHEDULED TASK IS A STORED GRANT                                       ║
 * ║                                                                          ║
 * ║ Creating one is authorized once, at creation. Then it fires every night  ║
 * ║ for a year — mutating AWS resources, with the creator's authority, long  ║
 * ║ after that person changed teams, was demoted to Viewer, or left the      ║
 * ║ company. Nothing else in the system re-checks it: the worker sends an    ║
 * ║ internal key, and the internal key means "I am the platform", not "this  ║
 * ║ user may still do this".                                                 ║
 * ║                                                                          ║
 * ║ So the permission is recompiled HERE, at execution, from the creator's   ║
 * ║ CURRENT role — never from anything captured at creation time. Role       ║
 * ║ reduced, membership removed, user deleted: the task fails closed and is  ║
 * ║ marked `permission_revoked` rather than running with stale authority.    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { getAbilityForPrincipal } from '@/lib/rbac/ability-cache';
import { buildPrincipalFor } from '@/lib/rbac/session-ability';
import { getPrismaClient } from '@/lib/db/pg-config';
import type { ScheduledTask } from './types';

/**
 * The permission a scheduled agent run requires — same as a manual trigger.
 *
 * MUST stay identical to what POST /api/agent-ops/scheduled-tasks/[taskId]/trigger
 * enforces. If the two drift, a role can fire a task by hand while its nightly
 * runs fail closed as `permission_revoked` — the failure is silent, deferred to
 * the next cron tick, and looks like a broken scheduler rather than a permission.
 */
export const SCHEDULED_TASK_REQUIREMENT = { action: 'execute', subject: 'ScheduledTask' } as const;

/** Machine-readable marker the worker keys off to mark the task and stop retrying. */
export const PERMISSION_REVOKED = 'permission_revoked';

export type ScheduledTaskGrant =
    | { ok: true; verified: true; userId: string; roleName: string }
    /**
     * Pre-Workstream-H row: no creator id was ever recorded, so there is nothing
     * to re-check. Allowed, but loudly — see the note on checkScheduledTaskGrant.
     */
    | { ok: true; verified: false; reason: string }
    | { ok: false; code: typeof PERMISSION_REVOKED; reason: string };

/**
 * Recompiles the creator's ability and asks whether they may still execute an
 * agent run.
 *
 * ── The one deliberate soft spot ──────────────────────────────────────────────
 * A task with no `createdByUserId` (created before this column existed) is
 * ALLOWED, with `verified: false` and an audit-worthy reason. Failing those
 * closed would silently stop every customer's existing automation the moment
 * this deploys — an outage caused by a data migration, not by a permission
 * decision. Re-saving a task through the UI stamps the creator and moves it onto
 * the enforced path. Every task created from now on is enforced.
 *
 * Never throws: an infrastructure failure here must not be able to run the task
 * either, so it is reported as a revocation with the error as its reason
 * (fail closed, section 8.7).
 */
export async function checkScheduledTaskGrant(task: ScheduledTask): Promise<ScheduledTaskGrant> {
    const userId = task.createdByUserId;

    if (!userId) {
        return {
            ok: true,
            verified: false,
            reason:
                `task ${task.taskId} predates creator-grant recording (createdByUserId is null) — ` +
                `its permissions cannot be re-checked; re-save the task to enable enforcement`,
        };
    }

    try {
        // auth_users is global (no tenantId column), so it is read unscoped. The
        // membership lookup that follows inside buildPrincipalFor is tenant-keyed.
        const user = await getPrismaClient().authUser.findUnique({
            where: { id: userId },
            select: { email: true, isSuperAdmin: true },
        });

        if (!user) {
            return {
                ok: false,
                code: PERMISSION_REVOKED,
                reason: `creator ${userId} no longer exists`,
            };
        }

        const principal = await buildPrincipalFor({
            userId,
            email: user.email,
            tenantId: task.tenantId,
            // null -> the role is resolved from user_tenant_roles as it is NOW.
            // Deliberately not task.createdByRoleId: that is a creation-time
            // snapshot, and trusting it would freeze a grant the admin revoked.
            roleName: null,
            isSuperAdmin: user.isSuperAdmin,
        });

        if (!principal) {
            return {
                ok: false,
                code: PERMISSION_REVOKED,
                reason: `creator ${userId} could not be resolved in tenant ${task.tenantId}`,
            };
        }

        if (!principal.isSuperAdmin && !principal.roleId) {
            return {
                ok: false,
                code: PERMISSION_REVOKED,
                reason: `creator ${user.email || userId} is no longer a member of tenant ${task.tenantId}`,
            };
        }

        const { ability, actionAliases } = await getAbilityForPrincipal(principal);

        // Rules compile to TERMINAL verbs, so 'execute' must be translated or the
        // check would find no rule and revoke every task in existence.
        const action = actionAliases[SCHEDULED_TASK_REQUIREMENT.action] ?? SCHEDULED_TASK_REQUIREMENT.action;

        if (!ability.can(action, SCHEDULED_TASK_REQUIREMENT.subject as never)) {
            const rule = ability.relevantRuleFor(action, SCHEDULED_TASK_REQUIREMENT.subject as never);
            return {
                ok: false,
                code: PERMISSION_REVOKED,
                reason:
                    `role '${principal.roleName || 'none'}' no longer grants ` +
                    `'${SCHEDULED_TASK_REQUIREMENT.action} ${SCHEDULED_TASK_REQUIREMENT.subject}'` +
                    (rule?.reason ? ` — ${rule.reason}` : ''),
            };
        }

        return { ok: true, verified: true, userId, roleName: principal.roleName };
    } catch (error) {
        // Cannot decide => cannot run. An autonomous, AWS-mutating run is not
        // something to attempt on a "probably fine".
        return {
            ok: false,
            code: PERMISSION_REVOKED,
            reason: `permission check failed: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}
