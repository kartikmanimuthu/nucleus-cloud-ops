/**
 * IInventoryRepository
 *
 * Contract for inventory resource persistence.
 * Implemented by InventoryDynamoRepository and InventoryPostgresRepository.
 * The feature flag USE_PG_INVENTORY controls which implementation is active.
 */

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
    region?: string;
    resourceType?: string;
    searchTerm?: string;
    page?: number;
    limit?: number;
}

export interface InventoryPage {
    resources: InventoryResource[];
    total: number;
}

export interface ResourceCount {
    resourceType: string;
    count: number;
}

export interface VectorSearchResult {
    resource: InventoryResource;
    distance: number;
}

export interface IInventoryRepository {
    listResources(filters: InventoryFilters): Promise<InventoryPage>;
    getResource(
        tenantId: string,
        accountId: string,
        resourceType: string,
        resourceId: string
    ): Promise<InventoryResource | null>;
    upsertResource(resource: Omit<InventoryResource, 'id'>): Promise<InventoryResource>;
    upsertBatch(resources: Omit<InventoryResource, 'id'>[]): Promise<number>;
    getResourceCounts(tenantId: string): Promise<ResourceCount[]>;
    deleteResourcesByAccount(tenantId: string, accountId: string): Promise<number>;
    searchByVector(
        tenantId: string,
        embedding: number[],
        topK?: number,
        filters?: { accountId?: string; region?: string }
    ): Promise<VectorSearchResult[]>;
}
