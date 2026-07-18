import type { Module, Action, PredefinedRole, RoleLevel, PermissionSet } from './types';

/**
 * Static permission map for the 4 predefined roles across 5 modules.
 * Per D-01, D-04: Owner > Admin > Member > Viewer hierarchy.
 */
export const ROLE_PERMISSIONS: Record<PredefinedRole, PermissionSet> = {
    Owner: {
        Accounts: ['create', 'read', 'update', 'delete'],
        Schedules: ['create', 'read', 'update', 'delete'],
        AIOps: ['create', 'read', 'update', 'delete'],
        Inventory: ['create', 'read', 'update', 'delete'],
        Settings: ['create', 'read', 'update', 'delete'],
        Dashboard: ['read'], // Dashboard is read-only for everyone
    },
    Admin: {
        Accounts: ['create', 'read', 'update', 'delete'],
        Schedules: ['create', 'read', 'update', 'delete'],
        AIOps: ['create', 'read', 'update', 'delete'],
        Inventory: ['create', 'read', 'update', 'delete'],
        Settings: ['create', 'read', 'update'], // No delete on Settings per D-04
        Dashboard: ['read'],
    },
    Member: {
        Accounts: ['create', 'read', 'update'],
        Schedules: ['create', 'read', 'update'],
        AIOps: ['create', 'read', 'update'],
        Inventory: ['create', 'read', 'update'],
        Settings: ['read'], // R only on Settings per D-04
        Dashboard: ['read'],
    },
    Viewer: {
        Accounts: ['read'],
        Schedules: ['read'],
        AIOps: ['read'],
        Inventory: ['read'],
        Settings: ['read'],
        Dashboard: ['read'],
    },
};

/**
 * Numeric hierarchy levels per D-09.
 * Owner=4, Admin=3, Member=2, Viewer=1.
 */
export const ROLE_LEVELS: Record<PredefinedRole, RoleLevel> = {
    Owner: 4,
    Admin: 3,
    Member: 2,
    Viewer: 1,
};

/** Minimum level required to assign roles (per D-09: Admin=3 and above only) */
const MIN_ASSIGN_LEVEL: RoleLevel = 3;

/**
 * Check if a predefined role has a specific permission.
 */
export function hasPermission(role: PredefinedRole, action: Action, module: Module): boolean {
    const perms = ROLE_PERMISSIONS[role];
    if (!perms) return false;
    return perms[module]?.includes(action) ?? false;
}

/**
 * Check a custom (DB-stored) permission set for a specific action on a module.
 */
export function hasCustomPermission(permissions: PermissionSet, action: Action, module: Module): boolean {
    return permissions[module]?.includes(action) ?? false;
}

/**
 * Per D-09: can assignerRole assign targetRole?
 * Member and Viewer cannot assign any roles.
 * Admin can assign Admin/Member/Viewer (same level or below).
 * Owner can assign any role.
 */
export function canAssignRole(assignerRole: PredefinedRole, targetRole: PredefinedRole): boolean {
    const assignerLevel = ROLE_LEVELS[assignerRole];
    const targetLevel = ROLE_LEVELS[targetRole];
    if (assignerLevel < MIN_ASSIGN_LEVEL) return false;
    return assignerLevel >= targetLevel;
}

/**
 * Per D-10: auto-level a custom role by its total permission count.
 * Thresholds: Owner-level(4), 15+=Admin-level(3), 8+=Member-level(2), else Viewer-level(1).
 * Owner threshold is derived from the static Owner permission set so it stays correct
 * when new read-only modules (e.g. Dashboard) are added.
 */
export function getAutoLevel(permissions: PermissionSet): RoleLevel {
    const totalActions = Object.values(permissions).flat().length;
    const ownerActionCount = Object.values(ROLE_PERMISSIONS.Owner).flat().length;
    if (totalActions >= ownerActionCount) return 4;
    if (totalActions >= 15) return 3;
    if (totalActions >= 8) return 2;
    return 1;
}
