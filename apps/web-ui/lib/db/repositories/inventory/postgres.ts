/**
 * InventoryPostgresRepository
 *
 * PostgreSQL implementation of IInventoryRepository using Prisma ORM.
 * Reads/writes the `inventory_resources` table (defined in libs/prisma/schema.prisma).
 *
 * Key improvement over DynamoDB path: listResources uses server-side WHERE/ILIKE/LIMIT/OFFSET
 * instead of fetching all records and filtering in memory.
 *
 * Fulltext search: When searchTerm is provided, uses tsvector search_vector column with
 * GIN index and ts_rank ordering instead of ILIKE on name only.
 *
 * Multi-tenant safety: every query is scoped by tenantId — no cross-tenant data access.
 */
import { getPrismaClient, getTenantClient } from '@/lib/db/pg-config';
import type {
    IInventoryRepository,
    InventoryResource,
    InventoryFilters,
    InventoryPage,
    ResourceCount,
} from './interface';

function transformRow(row: {
    id: string;
    tenantId: string;
    accountId: string;
    region: string;
    resourceType: string;
    resourceId: string;
    name: string | null;
    status: string | null;
    tags: unknown;
    metadata: unknown;
    discoveredAt: Date;
    updatedAt: Date;
}): InventoryResource {
    return {
        id: row.id,
        tenantId: row.tenantId,
        accountId: row.accountId,
        region: row.region,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        name: row.name ?? undefined,
        status: row.status ?? undefined,
        tags: (row.tags as Record<string, string>) || {},
        metadata: (row.metadata as Record<string, unknown>) || {},
        discoveredAt: row.discoveredAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}

export class InventoryPostgresRepository implements IInventoryRepository {
    async listResources(filters: InventoryFilters): Promise<InventoryPage> {
        try {
            const {
                tenantId,
                accountId,
                accountIds,
                region,
                resourceType,
                searchTerm,
                page = 1,
                limit = 50,
            } = filters;

            const skip = (page - 1) * limit;

            // When searchTerm is provided, use raw SQL with tsvector fulltext search
            if (searchTerm?.trim()) {
                return this.listResourcesFulltext(
                    tenantId, searchTerm.trim(), { accountId, accountIds, region, resourceType }, skip, limit
                );
            }

            // Standard Prisma path (no search term)
            const where: Record<string, unknown> = { tenantId, isCurrent: true };

            if (accountId) where.accountId = accountId;
            else if (accountIds?.length) where.accountId = { in: accountIds };
            if (region) where.region = region;
            if (resourceType) where.resourceType = resourceType;

            const client = getTenantClient(tenantId);
            const [total, rows] = await Promise.all([
                client.inventoryResource.count({ where }),
                client.inventoryResource.findMany({
                    where,
                    skip,
                    take: limit,
                    orderBy: { discoveredAt: 'desc' },
                }),
            ]);

            return { resources: rows.map(transformRow), total };
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[InventoryPostgresRepository] Error in listResources:', error);
            throw new Error(`Failed to list resources: ${msg}`);
        }
    }

    /**
     * Fulltext search path using search_vector @@ plainto_tsquery.
     * Results ranked by ts_rank (relevance), then discoveredAt desc.
     * All parameters are positional ($1, $2, ...) — never interpolated.
     */
    private async listResourcesFulltext(
        tenantId: string,
        searchTerm: string,
        filters: { accountId?: string; accountIds?: string[]; region?: string; resourceType?: string },
        skip: number,
        limit: number,
    ): Promise<InventoryPage> {
        const client = getTenantClient(tenantId);
        const params: unknown[] = [tenantId, searchTerm];
        let whereClause = `WHERE "tenantId" = $1 AND "isCurrent" = true AND "searchVector" @@ plainto_tsquery('english', $2)`;

        if (filters.accountId) {
            params.push(filters.accountId);
            whereClause += ` AND "accountId" = $${params.length}`;
        } else if (filters.accountIds?.length) {
            params.push(filters.accountIds);
            whereClause += ` AND "accountId" = ANY($${params.length})`;
        }
        if (filters.region) {
            params.push(filters.region);
            whereClause += ` AND region = $${params.length}`;
        }
        if (filters.resourceType) {
            params.push(filters.resourceType);
            whereClause += ` AND "resourceType" = $${params.length}`;
        }

        // Count query
        const countSql = `SELECT COUNT(*)::int AS total FROM inventory_resources ${whereClause}`;
        const countResult = await client.$queryRawUnsafe<[{ total: number }]>(countSql, ...params);
        const total = countResult[0]?.total ?? 0;

        // Data query with ts_rank ordering
        params.push(limit, skip);
        const limitParam = `$${params.length - 1}`;
        const offsetParam = `$${params.length}`;

        const dataSql = `
            SELECT id, "tenantId", "accountId", region, "resourceType", "resourceId",
                   name, status, tags, metadata, "discoveredAt", "updatedAt"
            FROM inventory_resources
            ${whereClause}
            ORDER BY ts_rank("searchVector", plainto_tsquery('english', $2)) DESC, "discoveredAt" DESC
            LIMIT ${limitParam} OFFSET ${offsetParam}
        `;

        const rows = await client.$queryRawUnsafe<
            Array<{
                id: string;
                tenantId: string;
                accountId: string;
                region: string;
                resourceType: string;
                resourceId: string;
                name: string | null;
                status: string | null;
                tags: unknown;
                metadata: unknown;
                discoveredAt: Date;
                updatedAt: Date;
            }>
        >(dataSql, ...params);

        return { resources: rows.map(transformRow), total };
    }

    async getResource(
        tenantId: string,
        accountId: string,
        resourceType: string,
        resourceId: string
    ): Promise<InventoryResource | null> {
        try {
            const row = await getTenantClient(tenantId).inventoryResource.findUnique({
                where: {
                    tenantId_accountId_resourceType_resourceId: {
                        tenantId,
                        accountId,
                        resourceType,
                        resourceId,
                    },
                },
            });
            return row ? transformRow(row) : null;
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[InventoryPostgresRepository] Error in getResource:', error);
            throw new Error(`Failed to get resource: ${msg}`);
        }
    }

    async upsertResource(
        resource: Omit<InventoryResource, 'id'>
    ): Promise<InventoryResource> {
        try {
            // D-03: Resolve tenantId from accountId when missing/default (Lambda write path safety)
            let resolvedTenantId = resource.tenantId;
            if (!resolvedTenantId || resolvedTenantId === 'default' || resolvedTenantId === 'org-default') {
                const account = await getPrismaClient().account.findFirst({
                    where: { accountId: resource.accountId },
                    select: { tenantId: true },
                });
                if (!account?.tenantId) {
                    console.error(`[InventoryPostgresRepository] No account found for accountId=${resource.accountId}, skipping upsert`);
                    return null as unknown as InventoryResource;
                }
                resolvedTenantId = account.tenantId;
            }

            const row = await getTenantClient(resolvedTenantId).inventoryResource.upsert({
                where: {
                    tenantId_accountId_resourceType_resourceId: {
                        tenantId: resolvedTenantId,
                        accountId: resource.accountId,
                        resourceType: resource.resourceType,
                        resourceId: resource.resourceId,
                    },
                },
                create: {
                    tenantId: resolvedTenantId,
                    accountId: resource.accountId,
                    region: resource.region,
                    resourceType: resource.resourceType,
                    resourceId: resource.resourceId,
                    name: resource.name,
                    status: resource.status,
                    tags: resource.tags as object,
                    metadata: resource.metadata as object,
                    discoveredAt: resource.discoveredAt
                        ? new Date(resource.discoveredAt)
                        : new Date(),
                },
                update: {
                    region: resource.region,
                    name: resource.name,
                    status: resource.status,
                    tags: resource.tags as object,
                    metadata: resource.metadata as object,
                },
            });
            return transformRow(row);
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[InventoryPostgresRepository] Error in upsertResource:', error);
            throw new Error(`Failed to upsert resource: ${msg}`);
        }
    }

    async upsertBatch(
        resources: Omit<InventoryResource, 'id'>[]
    ): Promise<number> {
        if (!resources.length) return 0;

        try {
            // D-04: Resolve tenantId from accountId when missing/default (Lambda write path safety)
            // All resources in a batch share the same accountId (same discovery scan)
            let resolvedTenantId = resources[0].tenantId;
            if (!resolvedTenantId || resolvedTenantId === 'default' || resolvedTenantId === 'org-default') {
                const account = await getPrismaClient().account.findFirst({
                    where: { accountId: resources[0].accountId },
                    select: { tenantId: true },
                });
                if (!account?.tenantId) {
                    console.error(`[InventoryPostgresRepository] No account found for accountId=${resources[0].accountId}, skipping batch upsert`);
                    return 0;
                }
                resolvedTenantId = account.tenantId;
            }

            // Stamp every resource with the resolved tenantId
            const scopedResources = resources.map((r) => ({ ...r, tenantId: resolvedTenantId }));

            const client = getTenantClient(resolvedTenantId);
            await client.$transaction(
                scopedResources.map((resource) =>
                    client.inventoryResource.upsert({
                        where: {
                            tenantId_accountId_resourceType_resourceId: {
                                tenantId: resource.tenantId,
                                accountId: resource.accountId,
                                resourceType: resource.resourceType,
                                resourceId: resource.resourceId,
                            },
                        },
                        create: {
                            tenantId: resource.tenantId,
                            accountId: resource.accountId,
                            region: resource.region,
                            resourceType: resource.resourceType,
                            resourceId: resource.resourceId,
                            name: resource.name,
                            status: resource.status,
                            tags: resource.tags as object,
                            metadata: resource.metadata as object,
                            discoveredAt: resource.discoveredAt
                                ? new Date(resource.discoveredAt)
                                : new Date(),
                        },
                        update: {
                            region: resource.region,
                            name: resource.name,
                            status: resource.status,
                            tags: resource.tags as object,
                            metadata: resource.metadata as object,
                        },
                    })
                )
            );
            return scopedResources.length;
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[InventoryPostgresRepository] Error in upsertBatch:', error);
            throw new Error(`Failed to batch upsert resources: ${msg}`);
        }
    }

    async getResourceCounts(tenantId: string): Promise<ResourceCount[]> {
        try {
            const groups = await getTenantClient(tenantId).inventoryResource.groupBy({
                by: ['resourceType'],
                where: { tenantId },
                _count: { resourceType: true },
                orderBy: { _count: { resourceType: 'desc' } },
            });

            return groups.map((g) => ({
                resourceType: g.resourceType,
                count: g._count.resourceType,
            }));
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[InventoryPostgresRepository] Error in getResourceCounts:', error);
            throw new Error(`Failed to get resource counts: ${msg}`);
        }
    }

    async deleteResourcesByAccount(
        tenantId: string,
        accountId: string
    ): Promise<number> {
        try {
            const result = await getTenantClient(tenantId).inventoryResource.deleteMany({
                where: { tenantId, accountId },
            });
            return result.count;
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[InventoryPostgresRepository] Error in deleteResourcesByAccount:', error);
            throw new Error(`Failed to delete resources: ${msg}`);
        }
    }

}
