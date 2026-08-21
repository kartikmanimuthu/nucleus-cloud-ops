import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { CapacityPlanningService } from '@/lib/capacity-planning-service';
import type { CapacityResourceType } from '@/lib/db/repositories/capacity-planning/interface';

// GET /api/capacity-planning/summary — resource-centric roll-up: installed vs.
// utilised vs. peak CPU/Mem vs. >70% breach count. Same shape as
// /api/scaling-audit/resources.
export async function GET(request: NextRequest) {
    const authError = await authorize('read', 'ScalingAudit');
    if (authError) return authError;

    try {
        const { searchParams } = new URL(request.url);
        const page = parseInt(searchParams.get('page') || '1', 10);
        const limit = parseInt(searchParams.get('limit') || '25', 10);
        const threshold = searchParams.get('threshold') ? Number(searchParams.get('threshold')) : undefined;

        const { resources, total } = await CapacityPlanningService.getUtilizationSummary(
            {
                tenantId: await getSessionTenantId(),
                accountId: searchParams.get('account') || undefined,
                region: searchParams.get('region') || undefined,
                resourceType: (searchParams.get('resourceType') as CapacityResourceType) || undefined,
                searchTerm: searchParams.get('search') || undefined,
                dateFrom: searchParams.get('dateFrom') || undefined,
                dateTo: searchParams.get('dateTo') || undefined,
                page,
                limit,
            },
            threshold
        );

        return NextResponse.json({
            success: true,
            data: resources,
            count: resources.length,
            meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
        });
    } catch (error: unknown) {
        console.error('API - Error fetching capacity planning summary:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to fetch capacity planning summary' },
            { status: 500 }
        );
    }
}
