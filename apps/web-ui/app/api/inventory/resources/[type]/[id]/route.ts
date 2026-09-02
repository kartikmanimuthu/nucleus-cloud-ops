import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { getInventoryRepository } from '@/lib/db/repository-factory';
import type { RouteAuthz } from '@nucleus/rbac';

/** Layer 1 permission declaration — see lib/rbac/rbac-allowlist.ts for the public set. */
export const authz: RouteAuthz = {
    GET: { action: 'read', subject: 'Resource' },
};

export async function GET(
    _req: NextRequest,
    ctx: { params: Promise<{ type: string; id: string }> },
) {
    const authError = await authorize('read', 'Resource');
    if (authError) return authError;

    try {
        const tenantId = await getSessionTenantId();
        if (!tenantId) {
            return NextResponse.json({ success: false, error: 'No tenant context' }, { status: 403 });
        }

        const { type, id } = await ctx.params;
        const resource = await getInventoryRepository().findOne({
            tenantId,
            resourceType: decodeURIComponent(type),
            resourceId: decodeURIComponent(id),
        });

        if (!resource) {
            return NextResponse.json({ success: false, error: 'Resource not found' }, { status: 404 });
        }

        return NextResponse.json({ success: true, data: resource });
    } catch (error) {
        console.error('API - Error fetching inventory resource:', error);
        return NextResponse.json({ success: false, error: 'Failed to fetch resource' }, { status: 500 });
    }
}
