import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth-options';
import { defineAbilitiesFor } from './abilities';
import { getUserTenantRole } from './role-service';
import { AppAbility } from './types';

// Default tenant ID for single-tenant mode
const DEFAULT_TENANT_ID = 'default';

/**
 * Get the CASL ability instance for the current server-side session.
 * This function fetches roles from both Cognito (groups) and DynamoDB (tenant roles).
 * 
 * @returns AppAbility instance with computed permissions
 */
export async function getServerAbility(): Promise<AppAbility> {
    const session = await getServerSession(authOptions);

    if (!session?.user) {
        // Return empty ability for unauthenticated users
        return defineAbilitiesFor([]);
    }

    // 1. Get Cognito groups (system-level roles)
    const cognitoGroups: string[] = (session.user as any).groups || [];

    // 2. Get user's Cognito sub (user ID)
    const userId = (session.user as any).sub || session.user.email;

    // 3. Get active tenant ID (default for now, can be extended)
    const activeTenantId = (session.user as any).activeTenantId || DEFAULT_TENANT_ID;

    // 4. Fetch tenant-specific role from DynamoDB
    let tenantRole: string | null = null;
    if (userId) {
        tenantRole = await getUserTenantRole(userId, activeTenantId);
    }

    // 5. Combine all roles
    const allRoles: string[] = [...cognitoGroups];
    if (tenantRole) {
        allRoles.push(tenantRole);
    }

    // 6. Build and return ability
    return defineAbilitiesFor(allRoles, activeTenantId);
}

/**
 * Get the roles array for the current session.
 * Useful for passing to client-side AbilityProvider.
 * 
 * @returns Array of role strings
 */
export async function getSessionRoles(): Promise<string[]> {
    const session = await getServerSession(authOptions);

    if (!session?.user) {
        return [];
    }

    const cognitoGroups: string[] = (session.user as any).groups || [];
    const userId = (session.user as any).sub || session.user.email;
    const activeTenantId = (session.user as any).activeTenantId || DEFAULT_TENANT_ID;

    let tenantRole: string | null = null;
    if (userId) {
        tenantRole = await getUserTenantRole(userId, activeTenantId);
    }

    const allRoles = [...cognitoGroups];
    if (tenantRole) {
        allRoles.push(tenantRole);
    }

    return allRoles;
}
