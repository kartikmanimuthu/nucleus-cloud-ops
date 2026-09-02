import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { getResourceGraphRepository } from '@/lib/db/repository-factory';
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
        if (!tenantId) return NextResponse.json({ success: false, error: 'No tenant context' }, { status: 403 });

        const { searchParams } = new URL(req.url);
        const fromId = searchParams.get('fromId');
        const toId = searchParams.get('toId');
        if (!fromId || !toId) return NextResponse.json({ success: false, error: 'fromId and toId are required' }, { status: 400 });

        const repo = getResourceGraphRepository();
        const [fromType, toType] = await Promise.all([
            repo.resolveResourceType({ tenantId, resourceId: fromId }),
            repo.resolveResourceType({ tenantId, resourceId: toId }),
        ]);
        if (!fromType || !toType) {
            return NextResponse.json({ success: false, error: 'Both resources must exist in inventory' }, { status: 404 });
        }

        const data = await repo.findPath({
            tenantId,
            from: { resourceType: fromType, resourceId: fromId },
            to: { resourceType: toType, resourceId: toId },
            maxDepth: Number(searchParams.get('maxDepth')) || undefined,
        });

        return NextResponse.json({ success: true, data });
    } catch (error) {
        console.error('API - Error finding resource graph path:', error);
        return NextResponse.json({ success: false, error: 'Failed to find resource graph path' }, { status: 500 });
    }
}
