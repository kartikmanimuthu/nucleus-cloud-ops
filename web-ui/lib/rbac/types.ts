import { PureAbility } from '@casl/ability';

// =============================================================================
// NEW MODULE-BASED TYPES (Phase 13 custom RBAC)
// =============================================================================

/** The 5 top-level modules in the permission matrix */
export type Module = 'Accounts' | 'Schedules' | 'AIOps' | 'Inventory' | 'Settings';

/** CRUD actions only — schedule execution maps to 'update', audit export maps to 'read' */
export type Action = 'create' | 'read' | 'update' | 'delete';

/** The 4 predefined roles with strict hierarchy */
export type PredefinedRole = 'Owner' | 'Admin' | 'Member' | 'Viewer';

/** Numeric hierarchy level: Owner=4, Admin=3, Member=2, Viewer=1 */
export type RoleLevel = 1 | 2 | 3 | 4;

/** Permission set shape — used by both static predefined roles and DB-stored custom roles */
export type PermissionSet = Record<Module, Action[]>;

/**
 * Maps old CASL subject names to new module names.
 * Used by authorize() for backward-compatible call sites during migration.
 */
export const SUBJECT_TO_MODULE: Record<string, Module> = {
    Account: 'Accounts',
    Schedule: 'Schedules',
    Resource: 'Inventory',
    User: 'Settings',
    Role: 'Settings',
    Tenant: 'Settings',
    AuditLog: 'Accounts',   // audit read maps to Accounts read (D-03)
    Agent: 'AIOps',
    KnowledgeBase: 'AIOps', // Agent + KnowledgeBase collapsed into AI Ops (D-02)
    Billing: 'Settings',
    all: 'Settings',        // wildcard fallback
};

/**
 * Maps old CASL action names to new CRUD actions.
 * Used by authorize() for backward-compatible call sites during migration.
 */
export const ACTION_MAP: Record<string, Action | Action[]> = {
    execute: 'update',   // schedule execution maps to update (D-03)
    approve: 'update',
    export: 'read',      // audit export maps to read (D-03)
    validate: 'read',
    use: 'read',
    manage: ['create', 'read', 'update', 'delete'],
    create: 'create',
    read: 'read',
    update: 'update',
    delete: 'delete',
};

// =============================================================================
// LEGACY CASL TYPES — kept for backward compatibility during migration
// Remove after all API routes are migrated in Plan 02
// =============================================================================

/** @deprecated Use Module instead. Will be removed after Plan 02 migration. */
export type Subjects =
    | 'Account'
    | 'Schedule'
    | 'Resource'
    | 'User'
    | 'Role'
    | 'Tenant'
    | 'AuditLog'
    | 'Billing'
    | 'Agent'
    | 'KnowledgeBase'
    | 'all';

/** @deprecated Use Action instead. Will be removed after Plan 02 migration. */
export type Actions =
    | 'create'
    | 'read'
    | 'update'
    | 'delete'
    | 'execute'
    | 'approve'
    | 'export'
    | 'validate'
    | 'use'
    | 'manage';

/** @deprecated Use PredefinedRole instead. Will be removed after Plan 02 migration. */
export type AppAbility = PureAbility<[Actions, Subjects]>;

/** @deprecated Will be removed after Plan 02 migration. */
export type SystemRole = 'SuperAdmins' | 'Support';

/** @deprecated Use PredefinedRole instead. Will be removed after Plan 02 migration. */
export type TenantRole = 'SuperAdmin' | 'TenantAdmin' | 'TenantOperator' | 'TenantViewer';

/** @deprecated Will be removed after Plan 02 migration. */
export type Role = SystemRole | TenantRole;

/** @deprecated Will be removed after Plan 02 migration. */
export interface UserTenantRole {
    PK: string;
    SK: string;
    EntityType: 'UserTenantRole';
    userId: string;
    tenantId: string;
    email: string;
    role: TenantRole;
    assignedAt: string;
    assignedBy: string;
}

/** @deprecated Will be removed after Plan 02 migration. */
export interface RoleDefinition {
    id: TenantRole;
    name: string;
    description: string;
    permissions: string[];
}

/** @deprecated Will be removed after Plan 02 migration. */
export const ROLE_DEFINITIONS: RoleDefinition[] = [
    {
        id: 'SuperAdmin',
        name: 'Super Admin',
        description: 'Full system access with all privileges across all tenants',
        permissions: ['Manage Everything', 'Manage Tenants', 'Manage All Users', 'System Settings'],
    },
    {
        id: 'TenantAdmin',
        name: 'Tenant Admin',
        description: 'Full access to manage accounts, schedules, users, and settings',
        permissions: ['Manage Accounts', 'Manage Schedules', 'Manage Users', 'View Audit Logs', 'Use AI Agent'],
    },
    {
        id: 'TenantOperator',
        name: 'Tenant Operator',
        description: 'Can manage schedules and execute operations on Schedule',
        permissions: ['View Accounts', 'Manage Schedules', 'Execute Schedules', 'View Audit Logs'],
    },
    {
        id: 'TenantViewer',
        name: 'Tenant Viewer',
        description: 'Read-only access to view resources and logs',
        permissions: ['View Accounts', 'View Schedules', 'View Audit Logs'],
    },
];
