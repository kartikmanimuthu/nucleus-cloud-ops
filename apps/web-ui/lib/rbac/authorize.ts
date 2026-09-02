import { NextResponse } from 'next/server';
import { subject as tagSubject } from '@casl/ability';

import { getAuthSession } from '@/lib/auth-session';
import {
    SUBJECT_TO_MODULE,
    ACTION_MAP,
    type Module,
    type Action,
    type PredefinedRole,
} from './types';
import { hasPermission, hasCustomPermission } from './permissions';
import { getCustomRolePermissions } from './custom-role-service';
import { getAbilityForSession } from './session-ability';
import { recordDenial } from './denials';

/** Predefined role names for runtime check */
const PREDEFINED_ROLES = new Set<string>(['Owner', 'Admin', 'Member', 'Viewer']);

export { getCustomRolePermissions };

/**
 * Layer 2 decision source (rollout section 16.1).
 *
 *   false (default) — the legacy matrix decides. The CASL verdict is still
 *                     computed and compared; a disagreement logs
 *                     `rbac.parity.mismatch` at error. This is the shadow period.
 *   true            — CASL decides.
 *
 * Removed in Workstream J. Flip only once the mismatch counter has stayed at zero
 * across a soak long enough to have exercised every role in active use.
 */
function dynamicAbacEnabled(): boolean {
    return process.env.DYNAMIC_ABAC_ENABLED === 'true';
}

function unauthenticated(): NextResponse {
    return NextResponse.json({ error: 'Unauthenticated', message: 'No valid session' }, { status: 401 });
}

function forbidden(action: string, subjectType: string, reason?: string): NextResponse {
    return NextResponse.json(
        {
            error: 'Forbidden',
            message: reason ?? `You do not have permission to ${action} ${subjectType}`,
            action,
            subject: subjectType,
        },
        { status: 403 }
    );
}

/**
 * The pre-CASL decision, kept verbatim so the shadow comparison is meaningful.
 * Deleted in Workstream J together with ROLE_PERMISSIONS and the two maps.
 */
async function legacyDecision(
    role: string,
    tenantId: string,
    action: string,
    subjectType: string
): Promise<boolean> {
    const module: Module = SUBJECT_TO_MODULE[subjectType] ?? (subjectType as Module);
    const mappedAction = ACTION_MAP[action];
    const actionsToCheck: Action[] = Array.isArray(mappedAction)
        ? mappedAction
        : [mappedAction ?? (action as Action)];

    if (PREDEFINED_ROLES.has(role)) {
        return actionsToCheck.some((a) => hasPermission(role as PredefinedRole, a, module));
    }

    const customPerms = await getCustomRolePermissions(role, tenantId);
    if (!customPerms) return false;
    return actionsToCheck.some((a) => hasCustomPermission(customPerms, a, module));
}

interface CaslVerdict {
    allowed: boolean;
    reason?: string;
    roleName: string;
    userId: string;
    email: string;
    tenantId: string;
}

/**
 * Evaluates the CASL ability. Returns null when the ability could not be built or
 * the compiler threw — the caller decides what that means, and in both modes it
 * means DENY, never allow (fail-closed contract, section 8.7).
 */
async function evaluateCasl(
    action: string,
    subjectType: string,
    subjectData?: Record<string, unknown>
): Promise<CaslVerdict | null> {
    try {
        const session = await getAbilityForSession();
        if (!session) return null;

        const { ability, principal, dropped, actionAliases } = session;

        if (dropped.length > 0) {
            // A dropped rule is a permission that mysteriously does not work.
            console.error('[rbac] rules dropped during compilation:', JSON.stringify(dropped));
        }

        // Rules are compiled with TERMINAL verbs, so an aliased verb must be
        // translated before it reaches CASL — otherwise authorize('execute',
        // 'Schedule') finds no rule and denies. This is ACTION_MAP, as data.
        const resolvedAction = actionAliases[action] ?? action;

        // The third argument went from ignored (`_subjectData`) to enforced.
        // subject() tags a plain object with its CASL type so that conditions
        // evaluate against the real row instead of the bare subject name.
        const target = subjectData ? tagSubject(subjectType, { ...subjectData }) : subjectType;

        let allowed = ability.can(resolvedAction, target as never);
        const rule = ability.relevantRuleFor(resolvedAction, target as never);

        // ── Conditional grant without a row = DENY ───────────────────────────
        // CASL evaluates conditions only against a subject INSTANCE. Asked about a
        // bare subject type it answers "could this ever be allowed", so a
        // conditionally-granted role would sail through any call site that forgot
        // the third argument — silently turning "only your own accounts" into
        // "all accounts". Refusing here makes the omission fail closed and loud
        // instead of quietly permissive.
        if (allowed && !subjectData && rule?.conditions) {
            console.error(
                '[rbac] rbac.conditional_grant.no_subject_data',
                JSON.stringify({ action, subject: subjectType, resolvedAction })
            );
            allowed = false;
        }

        return {
            allowed,
            reason: allowed
                ? undefined
                : (rule?.reason ??
                  (!subjectData && rule?.conditions
                      ? 'This action is conditionally granted and requires the target record.'
                      : undefined)),
            roleName: principal.roleName,
            userId: principal.userId,
            email: principal.email,
            tenantId: principal.tenantId,
        };
    } catch (error) {
        console.error('[rbac] ability evaluation failed:', error);
        return null;
    }
}

/**
 * Authorization helper for API routes.
 * Returns a NextResponse error if unauthorized, or null if authorized.
 *
 * Signature is unchanged — all existing call sites work without modification.
 *
 * @example
 * const authError = await authorize('delete', 'Schedule');
 * if (authError) return authError;
 *
 * @example resource-aware (Layer 2 proper — load the row, then authorize, then mutate)
 * const schedule = await repo.getById(id);
 * const authError = await authorize('update', 'Schedule', { accountId: schedule.accountId });
 * if (authError) return authError;
 */
export async function authorize(
    action: string,
    subjectType: string,
    subjectData?: Record<string, unknown>
): Promise<NextResponse | null> {
    const session = await getAuthSession();

    if (!session?.user) return unauthenticated();

    // SuperAdmin bypasses all permission checks
    if (session.user.isSuperAdmin === true) return null;

    const tenantId = session.user.tenantId ?? '';

    const verdict = await evaluateCasl(action, subjectType, subjectData);

    if (dynamicAbacEnabled()) {
        if (!verdict) {
            // Could not decide. Deny and alarm; never fall through to allow.
            console.error(`[rbac] no verdict for '${action} ${subjectType}' — denying`);
            return forbidden(action, subjectType);
        }
        if (!verdict.allowed) {
            await recordDenial({
                userId: verdict.userId,
                email: verdict.email,
                tenantId: verdict.tenantId,
                roleName: verdict.roleName,
                action,
                subject: subjectType,
                reason: verdict.reason,
            });
            return forbidden(action, subjectType, verdict.reason);
        }
        return null;
    }

    // ── Shadow mode: the legacy matrix decides, CASL is compared ─────────────
    //
    // ── RESOLVE THE ROLE FROM THE FK, NOT FROM THE NAME ─────────────────────
    // `session.user.role` is user_tenant_roles.role — a free-text NAME column
    // the schema itself labels "keep for backward compat" (schema.prisma:199).
    // NOTHING constrains it to agree with user_tenant_roles.roleId: the CHECK
    // that once validated it was dropped in 20260403_drop_role_check_constraint
    // so custom role names could be arbitrary, and no trigger replaced it.
    //
    // resolveRole() (session-ability.ts:44) already treats the FK as
    // authoritative and consults the name only when roleId is NULL, warning when
    // it does. THIS path never got that treatment, and the divergence is not
    // hypothetical: nine `smc` memberships carry role='cloud-admin' against
    // roleId=cloud-read. Every one of them authorised here as cloud-admin —
    // full CRUD on Schedules, and create/read/update/delete on IAM — while the
    // sidebar correctly rendered them as cloud-read. A user presented as
    // read-only could reach /app/iam/roles and edit any role, including their
    // own. Hiding the nav entry was the only thing in the way, and use-can.ts:6
    // is explicit that nav is "UX, not security".
    //
    // verdict.roleName IS the FK-resolved name — it comes straight from
    // principal.roleName. Preferring it costs nothing: evaluateCasl() has
    // already run above, and getAbilityForSession() is request-cached, so this
    // adds no query. The session value stays as the fallback for the one case
    // the FK cannot cover — the ability failing to build at all.
    const role = verdict?.roleName || session.user.role;

    if (verdict?.roleName && session.user.role && verdict.roleName !== session.user.role) {
        // Loud on purpose: this is a data-integrity fault, and every occurrence
        // is a request that previously authorised as the wrong role.
        console.error(
            '[rbac] rbac.role.column_mismatch',
            JSON.stringify({
                userId: verdict.userId,
                tenantId,
                roleFromNameColumn: session.user.role,
                roleFromFk: verdict.roleName,
                using: verdict.roleName,
                action,
                subject: subjectType,
            })
        );
    }

    if (!role) return forbidden(action, subjectType);

    const legacyAllowed = await legacyDecision(role, tenantId, action, subjectType);

    if (verdict && verdict.allowed !== legacyAllowed) {
        // The gate for flipping DYNAMIC_ABAC_ENABLED is this counter staying at zero.
        console.error(
            '[rbac] rbac.parity.mismatch',
            JSON.stringify({
                action,
                subject: subjectType,
                role,
                tenantId,
                legacy: legacyAllowed,
                casl: verdict.allowed,
                // Conditions only bite when the row is supplied, so a mismatch here
                // is expected once subjectData starts flowing in Workstream F.
                hadSubjectData: Boolean(subjectData),
            })
        );
    }

    return legacyAllowed ? null : forbidden(action, subjectType);
}

/**
 * Check if the current user has admin privileges.
 *
 * ┌── DIVERGENCE FROM THE PLAN, DELIBERATE ───────────────────────────────────┐
 * │ The plan specifies `ability.can('manage', 'Settings')`. That would be     │
 * │ WRONG here and would lock admins out.                                     │
 * │                                                                           │
 * │ The compiler deliberately expands a `manage` grant into the module's      │
 * │ concrete grantable actions rather than emitting CASL's `manage` wildcard  │
 * │ (so that adding an action later cannot retroactively widen an existing    │
 * │ grant). Consequently no compiled rule ever carries action 'manage', and   │
 * │ `can('manage', 'Settings')` is false for everyone except SuperAdmin.      │
 * │                                                                           │
 * │ Today `isAdmin()` means role is Owner or Admin. Owner holds CRUD on       │
 * │ Settings, Admin holds CRU (no delete — see ROLE_PERMISSIONS). The         │
 * │ predicate that reproduces exactly that split, and keeps Member/Viewer     │
 * │ out, is `can('update', 'Settings')`. Parity is Workstream C's exit gate,  │
 * │ so behaviour preservation wins over the plan's literal wording.           │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export async function isAdmin(): Promise<boolean> {
    const session = await getAuthSession();
    if (!session?.user) return false;
    if (session.user.isSuperAdmin === true) return true;

    if (dynamicAbacEnabled()) {
        const verdict = await evaluateCasl('update', 'Settings');
        return verdict?.allowed === true;
    }

    // FK-first, for the same reason as authorize() above: user_tenant_roles.role
    // is unconstrained free text and can name a different role than roleId points
    // at. getAbilityForSession() is request-cached, so this is not an extra query.
    const principal = (await getAbilityForSession())?.principal;
    const role = principal?.roleName || session.user.role;

    return role === 'Owner' || role === 'Admin';
}

/**
 * Check if the current user can perform an action on a subject.
 */
export async function can(action: string, subjectType: string): Promise<boolean> {
    const result = await authorize(action, subjectType);
    return result === null;
}

/**
 * Check if the current user cannot perform an action on a subject.
 */
export async function cannot(action: string, subjectType: string): Promise<boolean> {
    const result = await authorize(action, subjectType);
    return result !== null;
}
