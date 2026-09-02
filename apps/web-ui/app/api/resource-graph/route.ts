import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { getResourceGraphRepository, getAccountRepository } from '@/lib/db/repository-factory';
import type { RouteAuthz } from '@nucleus/rbac';

/** Layer 1 permission declaration — see lib/rbac/rbac-allowlist.ts for the public set. */
export const authz: RouteAuthz = {
    GET: { action: 'read', subject: 'ResourceGraph' },
};

export async function GET(req: NextRequest) {
    const authError = await authorize('read', 'ResourceGraph');
    if (authError) return authError;

    try {
        const tenantId = await getSessionTenantId();
        if (!tenantId) {
            return NextResponse.json({ success: false, error: 'No tenant context' }, { status: 403 });
        }

        const { searchParams } = new URL(req.url);
        const resourceId = searchParams.get('resourceId');
        const requestedType = searchParams.get('resourceType');
        if (!resourceId) {
            return NextResponse.json({ success: false, error: 'resourceId is required' }, { status: 400 });
        }

        const repo = getResourceGraphRepository();

        // The id is the authority: a caller-supplied type may be wrong or absent.
        const resolvedType = await repo.resolveResourceType({ tenantId, resourceId });
        const resourceType = resolvedType ?? requestedType;
        if (!resourceType) {
            return NextResponse.json({ success: false, error: 'resourceType is required when the resource is not in inventory' }, { status: 400 });
        }

        const deps = await repo.getResourceDependencies({ tenantId, resourceType, resourceId });

        // Freshness is worst-case across every account in the answer: edges cross
        // accounts, so one account's timestamp would overstate how fresh this is.
        const represented = new Set(deps.accountIds);
        const accounts = await getAccountRepository().listByTenant(tenantId);
        const relevant = accounts.filter((a) => represented.size === 0 || represented.has(a.accountId));
        const times = relevant.map((a) => a.lastSyncedAt).filter(Boolean) as string[];
        const neverScanned = relevant.some((a) => !a.lastSyncedAt);

        return NextResponse.json({
            success: true,
            data: {
                focus: { resourceType, resourceId, exists: resolvedType !== null },
                asOf: {
                    oldestSyncedAt: times.length ? times.slice().sort()[0] : null,
                    accountsRepresented: relevant.length,
                    neverScanned,
                },
                dependents: deps.dependents,
                dependsOn: deps.dependsOn,
            },
        });
    } catch (error) {
        console.error('API - Error fetching resource graph:', error);
        return NextResponse.json({ success: false, error: 'Failed to fetch resource graph' }, { status: 500 });
    }
}
