import { AbilityBuilder, PureAbility } from '@casl/ability';
import { AppAbility, Actions, Subjects } from './types';

/**
 * Define abilities based on user roles.
 * This function maps roles to permissions using CASL's AbilityBuilder.
 * 
 * @param roles - Array of role strings (from Cognito groups + DynamoDB)
 * @param tenantId - Optional tenant ID for tenant-scoped permissions
 * @returns AppAbility instance with defined permissions
 */
export function defineAbilitiesFor(
    roles: string[],
    tenantId?: string
): AppAbility {
    const { can, cannot, build } = new AbilityBuilder<AppAbility>(PureAbility);

    // ==========================================================================
    // SYSTEM-LEVEL ROLES (from Cognito Groups)
    // ==========================================================================

    // Super Admin - Full access to everything
    if (roles.includes('SuperAdmins')) {
        can('manage', 'all');
        return build();
    }

    // Support Role - Read-only access for support team
    if (roles.includes('Support')) {
        can('read', ['Tenant', 'User', 'Account', 'Schedule', 'AuditLog', 'Resource']);
        can('export', 'AuditLog');
    }

    // ==========================================================================
    // TENANT-LEVEL ROLES (from DynamoDB)
    // ==========================================================================

    // SuperAdmin (DynamoDB role) - Full access to everything
    if (roles.includes('SuperAdmin')) {
        can('manage', 'all');
        return build();
    }

    // Tenant Admin - Full access within their tenant
    if (roles.includes('TenantAdmin') || roles.includes('TenantAdmins')) {
        can('manage', 'Account');
        can('manage', 'Schedule');
        can('manage', 'Resource');
        can('manage', 'User');
        can('manage', 'Agent');
        can(['create', 'read', 'update'], 'Role');
        can('read', ['AuditLog', 'Billing']);
        can('export', 'AuditLog');
        can(['execute', 'validate'], 'Schedule');
        can('validate', 'Account');
        cannot('delete', 'Tenant'); // Cannot delete their own tenant
    }

    // Tenant Operator - Manage schedules and execute operations (no Agent access, no Account validation)
    if (roles.includes('TenantOperator') || roles.includes('TenantOperators')) {
        can('read', 'Account'); // CANNOT validate (which would require manage or specific action)
        can('manage', 'Schedule'); // Can edit, add, delete schedules
        can('execute', 'Schedule'); // Can execute schedules
        can('read', 'Resource');
        can('read', 'AuditLog');
        cannot('read', 'User'); // Explicitly forbid User access
        cannot('validate', 'Account');
        cannot('use', 'Agent');
    }

    // Tenant Viewer - Read-only access (no execution, no validation)
    if (roles.includes('TenantViewer') || roles.includes('TenantViewers')) {
        can('read', ['Account', 'Schedule', 'Resource', 'AuditLog']);
        cannot('execute', 'Schedule'); // Explicitly forbid execution
        cannot('validate', 'Account');
        cannot('use', 'Agent');
        // Do NOT use cannot('manage', 'all') as it overrides the read permissions above
    }

    return build();
}

/**
 * Check if a user has a specific permission.
 * Utility function for simple permission checks.
 */
export function hasPermission(
    roles: string[],
    action: Actions,
    subject: Subjects
): boolean {
    const ability = defineAbilitiesFor(roles);
    return ability.can(action, subject);
}
