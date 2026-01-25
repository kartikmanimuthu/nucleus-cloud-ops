// RBAC Module Exports
// This file exports all RBAC-related functionality for easy imports

// Types
export * from './types';

// Ability definitions
export { defineAbilitiesFor, hasPermission } from './abilities';

// React context and hooks (client-side)
export {
    AbilityContext,
    Can,
    useAbility,
    usePermission,
    AbilityProvider
} from './AbilityContext';

// Server-side utilities
export { getServerAbility, getSessionRoles } from './server-ability';

// API route authorization
export { authorize, isAdmin, can, cannot } from './authorize';

// Role service (DynamoDB operations)
export {
    getUserTenantRole,
    getUserAllRoles,
    assignUserRole,
    getTenantUsers
} from './role-service';
