// workers/src/jobs/right-sizing/services/pricing-writer.ts
//
// Raw-pg persistence for the global pricing catalog (RS-007).
// pricing_catalog is global reference data (not tenant-scoped).
import type { PoolClient } from 'pg';
import { getPool } from '../../discovery/services/db.js';
import { createLogger } from '../../../lib/logger.js';
import type { PricingEntry } from './pricing-client.js';

const log = createLogger('right-sizing-pricing-writer');

/** Distinct regions across all active accounts (deduped). */
export async function getDistinctAccountRegions(): Promise<string[]> {
    const client: PoolClient = await getPool().connect();
    try {
        const result = await client.query(
            `SELECT DISTINCT unnest(regions) AS region FROM accounts WHERE active = true`
        );
        return result.rows.map((r) => r.region).filter(Boolean);
    } finally {
        client.release();
    }
}

/** Upsert pricing entries by (region, serviceCode, resourceClass). */
export async function upsertPricingEntries(entries: PricingEntry[]): Promise<number> {
    if (!entries.length) return 0;
    const client: PoolClient = await getPool().connect();
    let written = 0;
    try {
        for (const e of entries) {
            await client.query(
                `INSERT INTO pricing_catalog
                    (id, region, "serviceCode", "resourceClass", attributes,
                     "pricePerHour", "pricePerGiBMonth", "pricePerIopsMonth", currency, "refreshedAt")
                 VALUES (gen_random_uuid()::text, $1, $2, $3, $4::jsonb, $5, $6, $7, $8, now())
                 ON CONFLICT (region, "serviceCode", "resourceClass")
                 DO UPDATE SET attributes = EXCLUDED.attributes,
                               "pricePerHour" = EXCLUDED."pricePerHour",
                               "pricePerGiBMonth" = EXCLUDED."pricePerGiBMonth",
                               "pricePerIopsMonth" = EXCLUDED."pricePerIopsMonth",
                               currency = EXCLUDED.currency,
                               "refreshedAt" = now()`,
                [
                    e.region,
                    e.serviceCode,
                    e.resourceClass,
                    JSON.stringify(e.attributes ?? {}),
                    e.pricePerHour ?? null,
                    e.pricePerGiBMonth ?? null,
                    e.pricePerIopsMonth ?? null,
                    e.currency ?? 'USD',
                ]
            );
            written += 1;
        }
        return written;
    } catch (error) {
        log.error('Error upserting pricing entries', { error: error instanceof Error ? error.message : String(error) });
        throw error;
    } finally {
        client.release();
    }
}
