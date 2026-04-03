import { NextRequest, NextResponse } from 'next/server';
import { getInventoryRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';

/**
 * GET /api/inventory/resources
 * List discovered resources with pagination and filtering.
 * Delegates to getInventoryRepository() — controlled by USE_PG_INVENTORY feature flag.
 */
export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const tenantId = await getSessionTenantId();

        // Normalize accountIds (comma-separated) → accountId (single)
        const accountIdsParam = searchParams.get('accountIds');
        const accountIds = accountIdsParam?.split(',').filter(Boolean);
        const accountId = searchParams.get('accountId')
            || (accountIds?.length === 1 ? accountIds[0] : undefined);

        const repo = getInventoryRepository();
        const result = await repo.listResources({
            tenantId,
            accountId,
            region: searchParams.get('region') || undefined,
            resourceType: searchParams.get('resourceType') || undefined,
            searchTerm: searchParams.get('search') || undefined,
            limit: parseInt(searchParams.get('limit') || '50', 10),
            page: parseInt(searchParams.get('page') || '1', 10),
        });

        return NextResponse.json({
            resources: result.resources,
            count: result.resources.length,
            total: result.total,
            hasMore: result.resources.length < result.total,
        });
    } catch (error: unknown) {
        console.error('Error fetching inventory resources:', error);
        const message = error instanceof Error ? error.message : 'Failed to fetch resources';
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
