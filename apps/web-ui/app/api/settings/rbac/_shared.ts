/**
 * Shared plumbing for the RBAC registry admin routes: the actor every write
 * needs, and the SystemRowError → 403 / RegistryInUseError → 409 / else → 400
 * status mapping every mutating handler applies to whatever registry-admin-
 * writes.ts throws. Was duplicated across three route handlers before this
 * file existed; this task adds two more, which is what made the duplication
 * worth ending.
 *
 * Not itself a route — `_` keeps rbac-sync's route-file scan (which only
 * looks for `route.ts`) from ever mistaking it for one.
 */
import { getAuthSession, getSessionTenantId } from '@/lib/auth-session';
import { RegistryInUseError, SystemRowError } from '@/lib/rbac/registry-admin-writes';
import type { RbacActor } from '@/lib/rbac/registry-service';

export async function resolveActor(): Promise<RbacActor> {
    const tenantId = await getSessionTenantId();
    const session = await getAuthSession();
    return {
        userId: session?.user?.id ?? 'unknown',
        email: session?.user?.email ?? 'unknown',
        tenantId,
    };
}

/** SystemRowError → 403, RegistryInUseError → 409, everything else → 400. */
export function mapRegistryError(error: unknown): number {
    if (error instanceof SystemRowError) return 403;
    if (error instanceof RegistryInUseError) return 409;
    return 400;
}
