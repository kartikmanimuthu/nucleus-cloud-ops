// workers/src/jobs/right-sizing/index.ts
//
// Right Sizing worker orchestrator (RS-015 + RS-016).
// Clones the discovery fan-out structure: daily fan-out → one stately scan job per tenant
// (singleton per tenant). Each scan: read inventory → AssumeRole per account → collect +
// summarize CloudWatch metrics → run the rule engine → upsert recommendations → run record
// + audit. Gated by RIGHT_SIZING_ENABLED.
import type PgBoss from 'pg-boss';
import { createLogger } from '../../lib/logger.js';
import type { JobExecutor } from '../../executor/index.js';
import { getAllTenants, getTenantAccounts } from '../discovery/services/account-service.js';
import { assumeRole } from '../discovery/services/sts-service.js';
import { writeAuditLog } from '../discovery/services/audit-service.js';
import { shouldRunTenant } from '../discovery/index.js';
import { collect } from './services/metric-collector.js';
import { summarize } from './services/metric-summarizer.js';
import { evaluate } from './services/engine.js';
import {
    getAnalyzableResources,
    loadCatalog,
    upsertRecommendations,
    createRun,
    finishRun,
    hasActiveRun,
    getTenantPeriodConfig,
    updateLastRun,
} from './services/db-writer.js';
import { RIGHT_SIZING_CONFIG } from './config.js';
import type { AnalyzableResource, RecommendationOutput } from './types.js';

const log = createLogger('right-sizing');
const FAN_OUT = 'right-sizing-fan-out';
const SCAN = 'right-sizing-scan';

export function isRightSizingEnabled(): boolean {
    return process.env.RIGHT_SIZING_ENABLED === 'true';
}

export interface RightSizingScanJob {
    tenantId: string;
    trigger: 'schedule' | 'manual';
    /** When provided (e.g. enqueued by the API), reuse this run instead of creating a new one. */
    runId?: string;
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
    const m = new Map<string, T[]>();
    for (const it of items) {
        const k = key(it);
        (m.get(k) ?? m.set(k, []).get(k)!).push(it);
    }
    return m;
}

/** Run the full analysis for one tenant. */
export async function handleScan(jobData: unknown): Promise<void> {
    const { tenantId, trigger, runId: providedRunId } = jobData as RightSizingScanJob;
    if (!isRightSizingEnabled()) {
        log.info('RIGHT_SIZING_ENABLED not true — skipping scan', { tenantId });
        return;
    }
    const lookbackDays = RIGHT_SIZING_CONFIG.lookbackDays;
    // Reuse the run the API pre-created (if any), else create one (scheduled path).
    const runId = providedRunId ?? (await createRun(tenantId, trigger, lookbackDays));
    const errors: Array<{ accountId?: string; region?: string; error: string }> = [];
    let accountsScanned = 0;
    let resourcesAnalyzed = 0;
    const allOutputs: RecommendationOutput[] = [];

    try {
        const resources = await getAnalyzableResources(tenantId);
        const regions = [...new Set(resources.map((r) => r.region))];
        const catalog = await loadCatalog(regions);
        const accounts = await getTenantAccounts(tenantId);
        const acctMap = new Map(accounts.map((a) => [a.accountId, a]));

        const byAccount = groupBy(resources, (r) => r.accountId);
        const nowMs = Date.now();

        for (const [accountId, acctResources] of byAccount) {
            const account = acctMap.get(accountId);
            if (!account?.roleArn) {
                errors.push({ accountId, error: 'No active account / roleArn for resources' });
                continue;
            }
            const byRegion = groupBy(acctResources, (r) => r.region);
            try {
                accountsScanned += 1;
                for (const [region, regionResources] of byRegion) {
                    try {
                        const assumed = await assumeRole(account.roleArn, accountId, region, account.externalId);
                        const metrics = await collect(regionResources, assumed, region, {
                            lookbackDays,
                            periodSeconds: RIGHT_SIZING_CONFIG.metricPeriodSeconds,
                            nowMs,
                        });
                        for (const resource of regionResources) {
                            resourcesAnalyzed += 1;
                            const raw = metrics.get(resource.resourceId) ?? {};
                            const summary = summarize(raw, {
                                lookbackDays,
                                periodSeconds: RIGHT_SIZING_CONFIG.metricPeriodSeconds,
                            });
                            const out = evaluate(resource as AnalyzableResource, summary, catalog, RIGHT_SIZING_CONFIG);
                            if (out) allOutputs.push(out);
                        }
                    } catch (regionErr) {
                        errors.push({ accountId, region, error: String(regionErr) });
                    }
                }
            } catch (acctErr) {
                errors.push({ accountId, error: String(acctErr) });
            }
        }

        const written = await upsertRecommendations(tenantId, allOutputs, runId);
        const totalSavings = allOutputs.reduce((s, o) => s + (o.estimatedMonthlySavings || 0), 0);

        await finishRun(runId, tenantId, {
            status: errors.length && !written ? 'failed' : 'completed',
            accountsScanned,
            resourcesAnalyzed,
            recommendationsGenerated: written,
            totalEstimatedSavings: totalSavings,
            errors,
        });
        await writeAuditLog({
            tenantId,
            eventType: 'right_sizing.run.completed',
            action: 'Right Sizing scan completed',
            resourceId: runId,
            status: 'success',
            severity: 'info',
            details: `Analyzed ${resourcesAnalyzed} resources across ${accountsScanned} account(s); ${written} recommendations, ~$${totalSavings.toFixed(2)}/mo potential savings.`,
            metadata: { runId, trigger, errors: errors.length },
        });
        log.info('Scan complete', { tenantId, runId, resourcesAnalyzed, written, totalSavings });
    } catch (err) {
        log.error('Scan failed', { tenantId, runId, error: String(err) });
        await finishRun(runId, tenantId, {
            status: 'failed',
            accountsScanned,
            resourcesAnalyzed,
            recommendationsGenerated: 0,
            totalEstimatedSavings: 0,
            errors: [...errors, { error: String(err) }],
        });
        throw err; // let pg-boss retry
    }
}

export async function register(boss: PgBoss, executor: JobExecutor): Promise<void> {
    executor.registerHandler?.('right-sizing-scan', handleScan);

    await boss.createQueue(FAN_OUT);
    await boss.updateQueue(FAN_OUT, { name: FAN_OUT, retryLimit: 1, expireInSeconds: 300 });

    const existing = await boss.getQueue(SCAN);
    if (!existing) {
        await boss.createQueue(SCAN, { name: SCAN, policy: 'stately', expireInSeconds: 3600 });
    }
    await boss.updateQueue(SCAN, { name: SCAN, expireInSeconds: 3600 });

    // Daily fan-out at 01:13 UTC (off the :00 mark).
    await boss.schedule(FAN_OUT, '13 1 * * *', {}, { tz: 'UTC' });

    await boss.work(FAN_OUT, { batchSize: 1 }, async () => {
        if (!isRightSizingEnabled()) {
            log.info('RIGHT_SIZING_ENABLED not true — fan-out is a no-op');
            return;
        }
        const tenants = await getAllTenants();
        for (const tenant of tenants) {
            const { period, lastRunAt } = await getTenantPeriodConfig(tenant.id);
            if (!shouldRunTenant(lastRunAt, period)) {
                log.info('Skipping — interval not elapsed', { tenantId: tenant.id, period, lastRunAt });
                continue;
            }
            const jobId = await boss.send(
                SCAN,
                { tenantId: tenant.id, trigger: 'schedule' } satisfies RightSizingScanJob,
                { singletonKey: `tenant:${tenant.id}`, retryLimit: 2, retryDelay: 60, retryBackoff: true }
            );
            if (jobId === null) {
                log.warn('Scan already queued/active, skipping', { tenantId: tenant.id });
            } else {
                await updateLastRun(tenant.id, new Date().toISOString());
            }
        }
    });

    await boss.work<RightSizingScanJob>(SCAN, { batchSize: 1 }, async ([job]) => {
        await executor.execute('right-sizing-scan', job.data);
    });

    log.info('Registered queues', { queues: [FAN_OUT, SCAN], cron: '13 1 * * *' });
}

/**
 * Enqueue an on-demand scan for a tenant (RS-016). Returns the pg-boss job id, or null if a
 * scan is already queued/active for the tenant (the per-tenant singleton prevents duplicates).
 */
export async function enqueueRightSizingScan(boss: PgBoss, tenantId: string): Promise<string | null> {
    if (await hasActiveRun(tenantId)) return null;
    return boss.send(
        SCAN,
        { tenantId, trigger: 'manual' } satisfies RightSizingScanJob,
        { singletonKey: `tenant:${tenantId}`, retryLimit: 2, retryDelay: 60, retryBackoff: true }
    );
}
