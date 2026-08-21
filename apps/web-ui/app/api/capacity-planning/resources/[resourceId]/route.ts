import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { CapacityPlanningService } from '@/lib/capacity-planning-service';
import type { CapacityResourceType } from '@/lib/db/repositories/capacity-planning/interface';

// GET /api/capacity-planning/resources/[resourceId] — one resource's installed
// vs. utilised vs. breach detail. Feeds the Scale Sentinel resource detail
// page's "Scaling & Capacity" tab (ecs/asg only — see clampToCompute).
export async function GET(request: NextRequest, { params }: { params: Promise<{ resourceId: string }> }) {
    const authError = await authorize('read', 'ScalingAudit');
    if (authError) return authError;

    try {
        const { resourceId } = await params;
        const { searchParams } = new URL(request.url);

        const detail = await CapacityPlanningService.getResourceDetail(
            {
                tenantId: await getSessionTenantId(),
                accountId: searchParams.get('account') || undefined,
                region: searchParams.get('region') || undefined,
                resourceType: (searchParams.get('resourceType') as CapacityResourceType) || undefined,
            },
            resourceId
        );

        if (!detail) {
            return NextResponse.json({ success: false, error: 'No capacity data found for this resource' }, { status: 404 });
        }
        return NextResponse.json({ success: true, data: detail });
    } catch (error: unknown) {
        console.error('API - Error fetching capacity resource detail:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to fetch capacity resource detail' },
            { status: 500 }
        );
    }
}
