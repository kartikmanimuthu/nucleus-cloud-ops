/**
 * IPricingCatalogRepository
 *
 * Contract for the cached AWS pricing catalog (RS-005).
 *
 * NOTE: This is GLOBAL reference data — NOT tenant-scoped. Implementations use the
 * base Prisma client (getPrismaClient), never getTenantClient().
 */

export interface PricingEntry {
    region: string;
    serviceCode: string; // AmazonEC2 | AmazonRDS | AmazonEBS
    resourceClass: string;
    attributes: Record<string, unknown>;
    pricePerHour?: number | null;
    pricePerGiBMonth?: number | null;
    pricePerIopsMonth?: number | null;
    currency?: string;
}

export interface IPricingCatalogRepository {
    getPrice(region: string, serviceCode: string, resourceClass: string): Promise<PricingEntry | null>;
    listByService(serviceCode: string, region?: string): Promise<PricingEntry[]>;
    upsertEntries(entries: PricingEntry[]): Promise<number>;
}
