import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { SpotGuardService } from '@/lib/spot-guard-service';
import type { SpotEligibility } from '@/lib/db/repositories/spot-guard/interface';

/**
 * GET /api/spot-guard/eligible — ECS services from inventory that could go on Spot.
 *
 * This is what makes the feature demoable before any ECS event has ever arrived: it reads
 * discovery's inventory rather than the Spot Guard registry, so a freshly onboarded account
 * shows its candidate services immediately instead of an empty page.
 */
export async function GET(request: NextRequest) {
    const authError = await authorize('read', 'SpotGuard');
    if (authError) return authError;

    try {
        const { searchParams } = new URL(request.url);
        const page = parseInt(searchParams.get('page') || '1', 10);
        const limit = parseInt(searchParams.get('limit') || '25', 10);

        const { services, total } = await SpotGuardService.listEligibleServices({
            tenantId: await getSessionTenantId(),
            accountId: searchParams.get('account') || undefined,
            region: searchParams.get('region') || undefined,
            eligibility: (searchParams.get('eligibility') as SpotEligibility) || undefined,
            searchTerm: searchParams.get('search') || undefined,
            page,
            limit,
        });

        return NextResponse.json({
            success: true,
            data: services,
            count: services.length,
            meta: { total, page, limit },
        });
    } catch (error: unknown) {
        console.error('API - Error fetching spot-guard eligible services:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to fetch eligible services' },
            { status: 500 },
        );
    }
}
