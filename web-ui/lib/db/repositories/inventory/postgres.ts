/**
 * InventoryPostgresRepository
 *
 * PostgreSQL implementation of IInventoryRepository using Prisma ORM.
 * Reads/writes the `inventory_resources` table (defined in prisma/schema.prisma).
 *
 * Key improvement over DynamoDB path: listResources uses server-side WHERE/ILIKE/LIMIT/OFFSET
 * instead of fetching all records and filtering in memory.
 *
 * Multi-tenant safety: every query is scoped by tenantId — no cross-tenant data access.
 */
import { getPrismaClient } from '@/lib/db/pg-config';
import type {
    IInventoryRepository,
    InventoryResource,
    InventoryFilters,
    InventoryPage,
    ResourceCount,
    VectorSearchResult,
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
                region,
                resourceType,
                searchTerm,
                page = 1,
                limit = 50,
            } = filters;

            const where: Record<string, unknown> = { tenantId };

            if (accountId) where.accountId = accountId;
            if (region) where.region = region;
            if (resourceType) where.resourceType = resourceType;

            if (searchTerm?.trim()) {
                where.name = { contains: searchTerm, mode: 'insensitive' };
            }

            const skip = (page - 1) * limit;

            const [total, rows] = await Promise.all([
                getPrismaClient().inventoryResource.count({ where }),
                getPrismaClient().inventoryResource.findMany({
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

    async getResource(
        tenantId: string,
        accountId: string,
        resourceType: string,
        resourceId: string
    ): Promise<InventoryResource | null> {
        try {
            const row = await getPrismaClient().inventoryResource.findUnique({
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
            const row = await getPrismaClient().inventoryResource.upsert({
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
            let count = 0;
            await getPrismaClient().$transaction(
                resources.map((resource) =>
                    getPrismaClient().inventoryResource.upsert({
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
            count = resources.length;
            return count;
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[InventoryPostgresRepository] Error in upsertBatch:', error);
            throw new Error(`Failed to batch upsert resources: ${msg}`);
        }
    }

    async getResourceCounts(tenantId: string): Promise<ResourceCount[]> {
        try {
            const groups = await getPrismaClient().inventoryResource.groupBy({
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
            const result = await getPrismaClient().inventoryResource.deleteMany({
                where: { tenantId, accountId },
            });
            return result.count;
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[InventoryPostgresRepository] Error in deleteResourcesByAccount:', error);
            throw new Error(`Failed to delete resources: ${msg}`);
        }
    }

    async searchByVector(
        tenantId: string,
        embedding: number[],
        topK: number = 50,
        filters?: { accountId?: string; region?: string }
    ): Promise<VectorSearchResult[]> {
        try {
            // Build parameterized query with cosine distance operator <=>
            const params: unknown[] = [`[${embedding.join(',')}]`, tenantId];
            let whereClause = 'WHERE tenant_id = $2 AND embedding IS NOT NULL';

            if (filters?.accountId) {
                params.push(filters.accountId);
                whereClause += ` AND account_id = $${params.length}`;
            }
            if (filters?.region) {
                params.push(filters.region);
                whereClause += ` AND region = $${params.length}`;
            }
            params.push(topK);
            const limitParam = `$${params.length}`;

            const sql = `
                SELECT id, "tenantId" AS "tenantId", "accountId" AS "accountId",
                       region, "resourceType" AS "resourceType", "resourceId" AS "resourceId",
                       name, status, tags, metadata, "discoveredAt" AS "discoveredAt",
                       "updatedAt" AS "updatedAt",
                       embedding <=> $1::vector AS distance
                FROM inventory_resources
                ${whereClause}
                ORDER BY embedding <=> $1::vector
                LIMIT ${limitParam}
            `;

            const rows = await getPrismaClient().$queryRawUnsafe<
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
                    distance: number;
                }>
            >(sql, ...params);

            return rows.map((row) => ({
                resource: transformRow(row),
                distance: Number(row.distance),
            }));
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error('[InventoryPostgresRepository] Error in searchByVector:', error);
            throw new Error(`Failed to search by vector: ${msg}`);
        }
    }
}
