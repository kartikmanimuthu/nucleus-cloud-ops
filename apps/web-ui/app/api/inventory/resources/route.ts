import { NextRequest, NextResponse } from 'next/server';
import { getInventoryRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { getTenantClient } from '@/lib/db/pg-config';

/**
 * GET /api/inventory/resources
 * List discovered resources with pagination and filtering.
 * Delegates to getInventoryRepository() — controlled by USE_PG_INVENTORY feature flag.
 */
export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const tenantId = await getSessionTenantId();

        // Normalize accountIds (comma-separated) → accountId (single) or accountIds (multi)
        const accountIdsParam = searchParams.get('accountIds');
        const accountIds = accountIdsParam?.split(',').filter(Boolean);
        const accountId = searchParams.get('accountId')
            || (accountIds?.length === 1 ? accountIds[0] : undefined);
        const multiAccountIds = !accountId && accountIds && accountIds.length > 1 ? accountIds : undefined;

        const repo = getInventoryRepository();
        const result = await repo.listResources({
            tenantId,
            accountId,
            accountIds: multiAccountIds,
            region: searchParams.get('region') || undefined,
            resourceType: searchParams.get('resourceType') || undefined,
            searchTerm: searchParams.get('search') || undefined,
            limit: parseInt(searchParams.get('limit') || '50', 10),
            page: parseInt(searchParams.get('page') || '1', 10),
        });

        // Enrich resources with account names
        const distinctAccountIds = [...new Set(result.resources.map(r => r.accountId))];
        const accountNameMap: Record<string, string> = {};
        if (distinctAccountIds.length > 0) {
            try {
                const accounts = await getTenantClient(tenantId).account.findMany({
                    where: { tenantId, accountId: { in: distinctAccountIds } },
                    select: { accountId: true, name: true },
                });
                for (const a of accounts) {
                    if (a.name) accountNameMap[a.accountId] = a.name;
                }
            } catch (e) {
                console.warn('Could not fetch account names for resources:', e);
            }
        }

        const enrichedResources = result.resources.map(r => ({
            ...r,
            accountName: accountNameMap[r.accountId] || undefined,
        }));

        return NextResponse.json({
            resources: enrichedResources,
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
