// RBAC Module Exports

// Types
export * from './types';

// Permission helpers
export { hasPermission, hasCustomPermission, canAssignRole, getAutoLevel, ROLE_PERMISSIONS, ROLE_LEVELS } from './permissions';

// API route authorization
export { authorize, isAdmin, can, cannot, getCustomRolePermissions } from './authorize';

// Role service (DynamoDB / PostgreSQL operations)
export {
    getUserTenantRole,
    getUserAllRoles,
    assignUserRole,
    getTenantUsers
} from './role-service';
