// workers/src/jobs/right-sizing/pricing-refresh.ts
//
// Weekly pricing-catalog refresh job (RS-007).
// Refreshes pricing_catalog from the AWS Price List API for every region in use across
// active tenant accounts. Per-region failures are isolated. Gated by RIGHT_SIZING_ENABLED.
import type PgBoss from 'pg-boss';
import { createLogger } from '../../lib/logger.js';
import { env } from '../../env.js';
import type { JobExecutor } from '../../executor/index.js';
import { fetchAllPricing } from './services/pricing-client.js';
import { getDistinctAccountRegions, upsertPricingEntries } from './services/pricing-writer.js';

const log = createLogger('right-sizing-pricing-refresh');
const QUEUE = 'right-sizing-pricing-refresh';

export function isRightSizingEnabled(): boolean {
    return env.RIGHT_SIZING_ENABLED === 'true';
}

export async function handlePricingRefresh(): Promise<void> {
    if (!isRightSizingEnabled()) {
        log.info('RIGHT_SIZING_ENABLED is not true — skipping pricing refresh');
        return;
    }
    const regions = await getDistinctAccountRegions();
    if (!regions.length) {
        log.info('No active-account regions found — nothing to refresh');
        return;
    }
    log.info('Refreshing pricing catalog', { regions });

    let total = 0;
    for (const region of regions) {
        try {
            const entries = await fetchAllPricing(region);
            const n = await upsertPricingEntries(entries);
            total += n;
            log.info('Region pricing refreshed', { region, entries: n });
        } catch (err) {
            // Isolate per-region failures so one bad region doesn't abort the rest.
            log.error('Region pricing refresh failed', { region, error: String(err) });
        }
    }
    log.info('Pricing refresh complete', { totalEntries: total, regions: regions.length });
}

export async function register(boss: PgBoss, executor: JobExecutor): Promise<void> {
    executor.registerHandler?.('right-sizing-pricing-refresh', handlePricingRefresh);

    // Singleton: only one refresh active at a time.
    const existing = await boss.getQueue(QUEUE);
    if (!existing) {
        await boss.createQueue(QUEUE, { name: QUEUE, policy: 'stately', expireInSeconds: 1800 });
    }
    await boss.updateQueue(QUEUE, { name: QUEUE, expireInSeconds: 1800, retryLimit: 1 });

    // Weekly: Sunday 03:17 UTC (off the :00 mark to avoid fleet-wide thundering herd).
    await boss.schedule(QUEUE, '17 3 * * 0', {}, { tz: 'UTC' });

    await boss.work(QUEUE, { batchSize: 1 }, async () => {
        await handlePricingRefresh();
    });

    log.info('Registered queue', { queue: QUEUE, cron: '17 3 * * 0' });
}
