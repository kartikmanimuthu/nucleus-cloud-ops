import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getReadRowFilter } from '@/lib/rbac/row-filter';
import { getSessionTenantId } from '@/lib/auth-session';
import { SpotGuardService } from '@/lib/spot-guard-service';
import type {
    CapacityState,
    ManagementState,
} from '@/lib/db/repositories/spot-guard/interface';

// GET /api/spot-guard/services — list/filter/paginate the managed-service registry
export async function GET(request: NextRequest) {
    const authError = await authorize('read', 'SpotGuard');
    if (authError) return authError;

    try {
        const { searchParams } = new URL(request.url);
        const page = parseInt(searchParams.get('page') || '1', 10);
        const limit = parseInt(searchParams.get('limit') || '25', 10);

        const { services, total } = await SpotGuardService.listServices({
            tenantId: await getSessionTenantId(),
            accountId: searchParams.get('account') || undefined,
            region: searchParams.get('region') || undefined,
            clusterName: searchParams.get('cluster') || undefined,
            capacityState: (searchParams.get('capacityState') as CapacityState) || undefined,
            managementState: (searchParams.get('managementState') as ManagementState) || undefined,
            searchTerm: searchParams.get('search') || undefined,
            page,
            limit,
            // Gate 3 — which services, not just whether. See lib/rbac/row-filter.ts.
            rowFilter: await getReadRowFilter('SpotGuard'),
        });

        return NextResponse.json({
            success: true,
            data: services,
            count: services.length,
            meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
        });
    } catch (error: unknown) {
        console.error('API - Error fetching spot-guard services:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to fetch services' },
            { status: 500 },
        );
    }
}
