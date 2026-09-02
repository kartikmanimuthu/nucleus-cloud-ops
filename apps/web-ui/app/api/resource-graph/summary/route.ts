import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { getResourceGraphRepository } from '@/lib/db/repository-factory';
import { parseFilters } from '../graph-request';
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
        const data = await getResourceGraphRepository().summarise({
            tenantId,
            accountId: searchParams.get('accountId') ?? undefined,
            filters: parseFilters(searchParams),
        });

        return NextResponse.json({ success: true, data });
    } catch (error) {
        console.error('API - Error summarising resource graph:', error);
        return NextResponse.json({ success: false, error: 'Failed to summarise resource graph' }, { status: 500 });
    }
}
