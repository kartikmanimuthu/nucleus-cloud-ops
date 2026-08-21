import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { getScalingAuditRepository } from '@/lib/db/repository-factory';
import type { ScalingEffectFilter, ScalingScope, ScalingSource, ScalingType } from '@/lib/db/repositories/scaling-audit/interface';

// GET /api/scaling-audit/resources — resource-centric roll-up for the list view.
// Takes the SAME filters as /events so the counts shown always match what the
// click-through displays.
export async function GET(request: NextRequest) {
    const authError = await authorize('read', 'ScalingAudit');
    if (authError) return authError;

    try {
        const { searchParams } = new URL(request.url);
        const page = parseInt(searchParams.get('page') || '1', 10);
        const limit = parseInt(searchParams.get('limit') || '25', 10);

        const { resources, total } = await getScalingAuditRepository().listResources({
            tenantId: await getSessionTenantId(),
            accountId: searchParams.get('account') || undefined,
            region: searchParams.get('region') || undefined,
            scope: (searchParams.get('scope') as ScalingScope) || undefined,
            source: (searchParams.get('source') as ScalingSource) || undefined,
            scalingType: (searchParams.get('scalingType') as ScalingType) || undefined,
            searchTerm: searchParams.get('search') || undefined,
            // Same default as /events: only 'all' opts out of capacity-changes-only.
            effect: (searchParams.get('effect') === 'all' ? 'all' : 'capacity_changes') as ScalingEffectFilter,
            dateFrom: searchParams.get('dateFrom') || undefined,
            dateTo: searchParams.get('dateTo') || undefined,
            page,
            limit,
        });

        return NextResponse.json({
            success: true,
            data: resources,
            count: resources.length,
            meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
        });
    } catch (error: unknown) {
        console.error('API - Error fetching scaling audit resources:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to fetch scaling resources' },
            { status: 500 }
        );
    }
}
