import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getSessionTenantId } from '@/lib/auth-session';
import { RightSizingService } from '@/lib/right-sizing-service';
import type { Finding, RecommendationStatus } from '@/lib/db/repositories/right-sizing/interface';

// GET /api/right-sizing/recommendations — list/filter/paginate/sort
export async function GET(request: NextRequest) {
    const authError = await authorize('read', 'RightSizing');
    if (authError) return authError;

    try {
        const { searchParams } = new URL(request.url);
        const page = parseInt(searchParams.get('page') || '1', 10);
        const limit = parseInt(searchParams.get('limit') || '25', 10);
        const sortParam = searchParams.get('sort');
        const sort = sortParam === 'confidence' || sortParam === 'resource' ? sortParam : 'savings';

        const { recommendations, total } = await RightSizingService.listRecommendations({
            tenantId: await getSessionTenantId(),
            accountId: searchParams.get('account') || undefined,
            region: searchParams.get('region') || undefined,
            resourceType: searchParams.get('resourceType') || undefined,
            finding: (searchParams.get('finding') as Finding) || undefined,
            status: (searchParams.get('status') as RecommendationStatus) || undefined,
            searchTerm: searchParams.get('search') || undefined,
            page,
            limit,
            sort,
        });

        return NextResponse.json({
            success: true,
            data: recommendations,
            count: recommendations.length,
            meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
        });
    } catch (error: unknown) {
        console.error('API - Error fetching right-sizing recommendations:', error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Failed to fetch recommendations' },
            { status: 500 }
        );
    }
}
