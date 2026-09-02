import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { getResourceGraphRepository } from '@/lib/db/repository-factory';
import { parseFilters } from '../graph-request';
import type { GraphPredicate } from '@/lib/resource-graph/graph-constants';
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
        const kind = searchParams.get('predicate');

        if (kind === 'by-type' && !searchParams.get('resourceType')) {
            return NextResponse.json({ success: false, error: 'resourceType is required for the by-type predicate' }, { status: 400 });
        }
        if (kind === 'by-vpc' && !searchParams.get('vpcId')) {
            return NextResponse.json({ success: false, error: 'vpcId is required for the by-vpc predicate' }, { status: 400 });
        }

        const predicate = kind === 'by-type'
            ? { kind, resourceType: searchParams.get('resourceType')! }
            : kind === 'by-vpc'
                ? { kind, vpcId: searchParams.get('vpcId')! }
                : kind === 'internet-facing' || kind === 'unmonitored' || kind === 'isolated'
                    ? { kind }
                    : null;

        if (!predicate) {
            return NextResponse.json({ success: false, error: 'predicate must be one of by-type, by-vpc, internet-facing, unmonitored, isolated' }, { status: 400 });
        }

        const data = await getResourceGraphRepository().queryGraph({
            tenantId,
            predicate: predicate as GraphPredicate,
            filters: parseFilters(searchParams),
            limit: Number(searchParams.get('limit')) || undefined,
        });

        return NextResponse.json({ success: true, data });
    } catch (error) {
        console.error('API - Error querying resource graph:', error);
        return NextResponse.json({ success: false, error: 'Failed to query resource graph' }, { status: 500 });
    }
}
