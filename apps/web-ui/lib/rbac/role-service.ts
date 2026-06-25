/**
 * RBAC Role Service
 *
 * Delegates all persistence to getRbacRepository() which reads USE_PG_RBAC
 * to select the DynamoDB or PostgreSQL backend.
 *
 * Function signatures are identical to the original — all callers are unaffected.
 */
import { TenantRole, UserTenantRole } from './types';
import { getRbacRepository } from '@/lib/db/repository-factory';

/**
 * Get the role of a user within a specific tenant.
 *
 * @param userId - Cognito sub (user ID)
 * @param tenantId - Tenant ID
 * @returns The user's role in the tenant, or null if not assigned
 */
export async function getUserTenantRole(
    userId: string,
    tenantId: string
): Promise<TenantRole | null> {
    try {
        return await getRbacRepository().getUserTenantRole(userId, tenantId);
    } catch (error) {
        console.error('Error fetching user tenant role:', error);
        return null;
    }
}

/**
 * Get all roles for a user across all tenants.
 *
 * @param userId - Cognito sub (user ID)
 * @returns Array of user-tenant-role mappings
 */
export async function getUserAllRoles(userId: string): Promise<UserTenantRole[]> {
    try {
        return await getRbacRepository().getUserAllRoles(userId);
    } catch (error) {
        console.error('Error fetching user roles:', error);
        return [];
    }
}

/**
 * Assign a role to a user within a tenant.
 *
 * @param userId - Cognito sub (user ID)
 * @param email - User's email
 * @param tenantId - Tenant ID
 * @param role - Role to assign
 * @param assignedBy - Email of the admin assigning the role
 */
export async function assignUserRole(
    userId: string,
    email: string,
    tenantId: string,
    role: TenantRole,
    assignedBy: string
): Promise<void> {
    await getRbacRepository().assignUserRole(userId, email, tenantId, role, assignedBy);
}

/**
 * Get all users in a tenant with their roles.
 *
 * @param tenantId - Tenant ID
 * @returns Array of user-tenant-role mappings for the tenant
 */
export async function getTenantUsers(tenantId: string): Promise<UserTenantRole[]> {
    try {
        return await getRbacRepository().getTenantUsers(tenantId);
    } catch (error) {
        console.error('Error fetching tenant users:', error);
        return [];
    }
}
