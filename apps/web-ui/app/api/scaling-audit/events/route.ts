import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { ScalingAuditService } from '@/lib/scaling-audit-service';
import type { ScalingEffectFilter, ScalingScope, ScalingSource, ScalingType } from '@/lib/db/repositories/scaling-audit/interface';

// GET /api/scaling-audit/events — list/filter/paginate scaling events
export async function GET(request: NextRequest) {
    const authError = await authorize('read', 'ScalingAudit');
    if (authError) return authError;

    try {
        const { searchParams } = new URL(request.url);
        const page = parseInt(searchParams.get('page') || '1', 10);
        const limit = parseInt(searchParams.get('limit') || '25', 10);

        const { events, total } = await ScalingAuditService.listEvents({
            tenantId: await getSessionTenantId(),
            accountId: searchParams.get('account') || undefined,
            region: searchParams.get('region') || undefined,
            scope: (searchParams.get('scope') as ScalingScope) || undefined,
            source: (searchParams.get('source') as ScalingSource) || undefined,
            scalingType: (searchParams.get('scalingType') as ScalingType) || undefined,
            excludeScalingTypes: searchParams.get('excludeScalingTypes')?.split(',').filter(Boolean) as ScalingType[] | undefined,
            resourceId: searchParams.get('resourceId') || undefined,
            searchTerm: searchParams.get('search') || undefined,
            // Only 'all' opts out; anything else (absent, unrecognised) keeps the
            // capacity-changes-only default so the noisy view is never the default.
            effect: (searchParams.get('effect') === 'all' ? 'all' : 'capacity_changes') as ScalingEffectFilter,
            dateFrom: searchParams.get('dateFrom') || undefined,
            dateTo: searchParams.get('dateTo') || undefined,
            page,
            limit,
        });

        return NextResponse.json({
            success: true,
            data: events,
            count: events.length,
            meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
        });
    } catch (error: unknown) {
        console.error('API - Error fetching scaling audit events:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to fetch scaling events' },
            { status: 500 }
        );
    }
}
