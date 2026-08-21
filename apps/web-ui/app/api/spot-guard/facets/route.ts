import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { SpotGuardService } from '@/lib/spot-guard-service';

/**
 * GET /api/spot-guard/facets — distinct regions and cluster names for the filter dropdowns.
 *
 * Separate from /services because the options must NOT depend on the current page: filtering to a
 * cluster absent from page 1 would otherwise remove its own option. Read-only and tiny, so it is
 * cheap to fetch once per page load.
 */
export async function GET(_request: NextRequest) {
    const authError = await authorize('read', 'SpotGuard');
    if (authError) return authError;

    try {
        const data = await SpotGuardService.getFacets(await getSessionTenantId());
        return NextResponse.json({ success: true, data });
    } catch (error) {
        console.error('API - Error fetching spot-guard facets:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to fetch facets' },
            { status: 500 },
        );
    }
}
