import { PureAbility } from '@casl/ability';

// Define your subjects (resources in your application)
export type Subjects =
    | 'Account'          // AWS account management
    | 'Schedule'         // Schedule CRUD
    | 'Resource'         // EC2/RDS/ECS resources
    | 'User'            // User management
    | 'Role'            // Role management
    | 'Tenant'          // Tenant settings
    | 'AuditLog'        // Audit logs
    | 'Billing'         // Billing & subscription
    | 'Agent'           // AI agent access
    | 'all';            // Wildcard for all resources

// Define your actions
export type Actions =
    | 'create'
    | 'read'
    | 'update'
    | 'delete'
    | 'execute'          // Execute schedules
    | 'approve'          // Approve changes
    | 'export'           // Export data
    | 'validate'         // Validate resources
    | 'use'              // Use features (e.g. AI Agent)
    | 'manage';          // All actions (admin)

// Define the ability type for your application
export type AppAbility = PureAbility<[Actions, Subjects]>;

// Available roles in the system
export type SystemRole = 'SuperAdmins' | 'Support';
export type TenantRole = 'SuperAdmin' | 'TenantAdmin' | 'TenantOperator' | 'TenantViewer';
export type Role = SystemRole | TenantRole;

// User-Tenant-Role mapping stored in DynamoDB
export interface UserTenantRole {
    PK: string;           // USER#{cognitoSub}
    SK: string;           // TENANT#{tenantId}
    EntityType: 'UserTenantRole';
    userId: string;       // Cognito sub
    tenantId: string;
    email: string;
    role: TenantRole;
    assignedAt: string;   // ISO timestamp
    assignedBy: string;   // Admin who assigned
}

// Role definition for admin display
export interface RoleDefinition {
    id: TenantRole;
    name: string;
    description: string;
    permissions: string[];
}

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
