/**
 * IRbacRepository
 *
 * Contract for RBAC (role-based access control) persistence.
 * Implemented by RbacDynamoRepository and RbacPostgresRepository.
 * The feature flag USE_PG_RBAC controls which implementation is active.
 */
import type { TenantRole, UserTenantRole } from '@/lib/rbac/types';

export interface IRbacRepository {
    /**
     * Get the role of a user within a specific tenant.
     * Returns the role string, or null if not assigned.
     */
    getUserTenantRole(userId: string, tenantId: string): Promise<TenantRole | null>;

    /**
     * Get all role assignments for a user across all tenants.
     */
    getUserAllRoles(userId: string): Promise<UserTenantRole[]>;

    /**
     * Assign (or update) a role for a user within a tenant.
     * Upsert semantics: overwrites if assignment already exists.
     */
    assignUserRole(
        userId: string,
        email: string,
        tenantId: string,
        role: TenantRole,
        assignedBy: string
    ): Promise<void>;

    /**
     * Get all users and their roles for a given tenant.
     */
    getTenantUsers(tenantId: string): Promise<UserTenantRole[]>;
}
