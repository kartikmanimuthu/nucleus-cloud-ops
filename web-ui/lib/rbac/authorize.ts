import { NextResponse } from 'next/server';
import { getServerAbility } from './server-ability';
import { getAuthSession } from '@/lib/auth-session';
import {
    Actions,
    Subjects,
    SUBJECT_TO_MODULE,
    ACTION_MAP,
    type Module,
    type Action,
    type PredefinedRole,
    type PermissionSet,
} from './types';
import { hasPermission, hasCustomPermission } from './permissions';

/** Predefined role names for runtime check */
const PREDEFINED_ROLES = new Set<string>(['Owner', 'Admin', 'Member', 'Viewer']);

/**
 * Stub for custom role permission lookup.
 * Plan 03 will replace this with a real DB lookup via Prisma.
 * Returns null (deny-all) for any unknown custom role.
 */
export async function getCustomRolePermissions(
    _roleName: string,
    _tenantId: string
): Promise<PermissionSet | null> {
    return null;
}

/**
 * Authorization helper for API routes.
 * Returns a NextResponse error if unauthorized, or null if authorized.
 *
 * When USE_NEW_RBAC=true: uses the new static ROLE_PERMISSIONS system.
 * Otherwise: falls back to CASL (existing behavior — zero risk rollout).
 *
 * Signature is backward-compatible — existing call sites work without changes.
 *
 * @example
 * const authError = await authorize('delete', 'Schedule');
 * if (authError) return authError;
 */
export async function authorize(
    action: Actions | Action,
    subjectType: Subjects | Module,
    subjectData?: Record<string, unknown>
): Promise<NextResponse | null> {
    // Feature flag: when not set or not 'true', use CASL fallback
    if (process.env.USE_NEW_RBAC !== 'true') {
        const ability = await getServerAbility();
        const { subject } = await import('@casl/ability');
        const canPerform = subjectData
            ? ability.can(action as Actions, subject(subjectType as Subjects, subjectData) as Subjects)
            : ability.can(action as Actions, subjectType as Subjects);

        if (!canPerform) {
            return NextResponse.json(
                {
                    error: 'Forbidden',
                    message: `You do not have permission to ${action} ${subjectType}`,
                    action,
                    subject: subjectType,
                },
                { status: 403 }
            );
        }
        return null;
    }

    // New RBAC path
    const session = await getAuthSession();

    if (!session?.user) {
        return NextResponse.json(
            { error: 'Unauthenticated', message: 'No valid session' },
            { status: 401 }
        );
    }

    // SuperAdmin bypasses all permission checks
    if (session.user.isSuperAdmin === true) {
        return null;
    }

    const role = session.user.role;

    if (!role) {
        return NextResponse.json(
            {
                error: 'Forbidden',
                message: `You do not have permission to ${action} ${subjectType}`,
                action,
                subject: subjectType,
            },
            { status: 403 }
        );
    }

    // Map old subject name to new module
    const module: Module = SUBJECT_TO_MODULE[subjectType] ?? (subjectType as Module);

    // Map old action name to new CRUD action(s)
    const mappedAction = ACTION_MAP[action];
    // For 'manage' which maps to an array, check if any action is permitted
    const actionsToCheck: Action[] = Array.isArray(mappedAction)
        ? mappedAction
        : [mappedAction ?? (action as Action)];

    let permitted = false;

    if (PREDEFINED_ROLES.has(role)) {
        // Static predefined role check
        permitted = actionsToCheck.some((a) =>
            hasPermission(role as PredefinedRole, a, module)
        );
    } else {
        // Custom role — look up from DB (stub returns null = deny)
        const tenantId = session.user.tenantId ?? '';
        const customPerms = await getCustomRolePermissions(role, tenantId);
        if (customPerms) {
            permitted = actionsToCheck.some((a) =>
                hasCustomPermission(customPerms, a, module)
            );
        }
    }

    if (!permitted) {
        return NextResponse.json(
            {
                error: 'Forbidden',
                message: `You do not have permission to ${action} ${subjectType}`,
                action,
                subject: subjectType,
            },
            { status: 403 }
        );
    }

    return null;
}

/**
 * Check if the current user has admin privileges.
 * When USE_NEW_RBAC=true: checks for Owner or Admin predefined role.
 */
export async function isAdmin(): Promise<boolean> {
    if (process.env.USE_NEW_RBAC !== 'true') {
        const ability = await getServerAbility();
        return ability.can('manage', 'all');
    }

    const session = await getAuthSession();
    if (!session?.user) return false;
    if (session.user.isSuperAdmin === true) return true;
    return session.user.role === 'Owner' || session.user.role === 'Admin';
}

/**
 * Check if the current user can perform an action on a subject.
 */
export async function can(action: Actions | Action, subjectType: Subjects | Module): Promise<boolean> {
    const result = await authorize(action, subjectType);
    return result === null;
}

/**
 * Check if the current user cannot perform an action on a subject.
 */
export async function cannot(action: Actions | Action, subjectType: Subjects | Module): Promise<boolean> {
    const result = await authorize(action, subjectType);
    return result !== null;
}
