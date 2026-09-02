/**
 * IInventoryRepository
 *
 * Contract for inventory resource persistence.
 * Implemented by InventoryDynamoRepository and InventoryPostgresRepository.
 * The feature flag USE_PG_INVENTORY controls which implementation is active.
 */

import type { PrismaRowFilter } from '@/lib/db/pg-config';

export interface InventoryResource {
    id: string;
    tenantId: string;
    accountId: string;
    region: string;
    resourceType: string;
    resourceId: string;
    name?: string;
    status?: string;
    tags: Record<string, string>;
    metadata: Record<string, unknown>;
    discoveredAt: string;
    updatedAt: string;
}

export interface InventoryFilters {
    tenantId: string;
    accountId?: string;
    accountIds?: string[];
    region?: string;
    resourceType?: string;
    searchTerm?: string;
    page?: number;
    limit?: number;
    /**
     * Gate 3 (RBAC row filtering): a Prisma `where` fragment restricting the
     * result to the rows the caller may read. Built by
     * getReadRowFilter() in lib/rbac/row-filter.ts and INTERSECTED with the
     * query below via andWhere() — never merged over it.
     */
    rowFilter?: PrismaRowFilter | null;
}

export interface InventoryPage {
    resources: InventoryResource[];
    total: number;
}

export interface ResourceCount {
    resourceType: string;
    count: number;
}

export interface IInventoryRepository {
    listResources(filters: InventoryFilters): Promise<InventoryPage>;
    getResource(
        tenantId: string,
        accountId: string,
        resourceType: string,
        resourceId: string
    ): Promise<InventoryResource | null>;
    findOne(args: {
        tenantId: string;
        resourceType: string;
        resourceId: string;
    }): Promise<InventoryResource | null>;
    upsertResource(resource: Omit<InventoryResource, 'id'>): Promise<InventoryResource>;
    upsertBatch(resources: Omit<InventoryResource, 'id'>[]): Promise<number>;
    getResourceCounts(tenantId: string): Promise<ResourceCount[]>;
    deleteResourcesByAccount(tenantId: string, accountId: string): Promise<number>;
}
