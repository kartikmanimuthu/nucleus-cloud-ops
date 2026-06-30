// =============================================================================
// MODULE-BASED TYPES (Phase 13 custom RBAC)
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
    Discovery: 'Inventory',
    User: 'Settings',
    Role: 'Settings',
    Tenant: 'Settings',
    AuditLog: 'Accounts',   // audit read maps to Accounts read (D-03)
    Agent: 'AIOps',
    Skill: 'AIOps',
    Memory: 'AIOps',        // Agent memory module — gated with AI Ops (read=view, delete=prune)
    KnowledgeBase: 'AIOps', // Agent + KnowledgeBase collapsed into AI Ops (D-02)
    Billing: 'Settings',
    Certificate: 'Settings',
    RightSizing: 'Inventory', // right-sizing analyzes discovered inventory (read=view, update=review/trigger scan)
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
// PERSISTENCE TYPES — used by repository layer and role-service
// =============================================================================

/** Role values stored in DynamoDB/PostgreSQL for tenant membership */
export type TenantRole = 'SuperAdmin' | 'TenantAdmin' | 'TenantOperator' | 'TenantViewer';

/** Shape of a user-tenant-role record returned from the repository */
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
