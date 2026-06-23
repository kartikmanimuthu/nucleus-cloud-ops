/**
 * PricingCatalogPostgresRepository
 *
 * PostgreSQL implementation of IPricingCatalogRepository.
 * Uses the base (un-scoped) Prisma client — pricing is global reference data, not tenant data.
 */
import { getPrismaClient } from '@/lib/db/pg-config';
import type { IPricingCatalogRepository, PricingEntry } from './interface';

interface PricingRow {
    region: string;
    serviceCode: string;
    resourceClass: string;
    attributes: unknown;
    pricePerHour: number | null;
    pricePerGiBMonth: number | null;
    pricePerIopsMonth: number | null;
    currency: string;
}

function transform(row: PricingRow): PricingEntry {
    return {
        region: row.region,
        serviceCode: row.serviceCode,
        resourceClass: row.resourceClass,
        attributes: (row.attributes as Record<string, unknown>) || {},
        pricePerHour: row.pricePerHour,
        pricePerGiBMonth: row.pricePerGiBMonth,
        pricePerIopsMonth: row.pricePerIopsMonth,
        currency: row.currency,
    };
}

export class PricingCatalogPostgresRepository implements IPricingCatalogRepository {
    async getPrice(region: string, serviceCode: string, resourceClass: string): Promise<PricingEntry | null> {
        const row = await getPrismaClient().pricingCatalogEntry.findUnique({
            where: { region_serviceCode_resourceClass: { region, serviceCode, resourceClass } },
        });
        return row ? transform(row as PricingRow) : null;
    }

    async listByService(serviceCode: string, region?: string): Promise<PricingEntry[]> {
        const rows = await getPrismaClient().pricingCatalogEntry.findMany({
            where: { serviceCode, ...(region ? { region } : {}) },
        });
        return (rows as PricingRow[]).map(transform);
    }

    async upsertEntries(entries: PricingEntry[]): Promise<number> {
        if (!entries.length) return 0;
        const db = getPrismaClient();
        // Chunk into transactions to bound statement count.
        const CHUNK = 200;
        for (let i = 0; i < entries.length; i += CHUNK) {
            const chunk = entries.slice(i, i + CHUNK);
            await db.$transaction(
                chunk.map((e) =>
                    db.pricingCatalogEntry.upsert({
                        where: {
                            region_serviceCode_resourceClass: {
                                region: e.region,
                                serviceCode: e.serviceCode,
                                resourceClass: e.resourceClass,
                            },
                        },
                        create: {
                            region: e.region,
                            serviceCode: e.serviceCode,
                            resourceClass: e.resourceClass,
                            attributes: (e.attributes ?? {}) as object,
                            pricePerHour: e.pricePerHour ?? null,
                            pricePerGiBMonth: e.pricePerGiBMonth ?? null,
                            pricePerIopsMonth: e.pricePerIopsMonth ?? null,
                            currency: e.currency ?? 'USD',
                        },
                        update: {
                            attributes: (e.attributes ?? {}) as object,
                            pricePerHour: e.pricePerHour ?? null,
                            pricePerGiBMonth: e.pricePerGiBMonth ?? null,
                            pricePerIopsMonth: e.pricePerIopsMonth ?? null,
                            currency: e.currency ?? 'USD',
                            refreshedAt: new Date(),
                        },
                    })
                )
            );
        }
        return entries.length;
    }
}
