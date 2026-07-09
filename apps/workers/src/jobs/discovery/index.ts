// workers/src/jobs/discovery/index.ts
import type PgBoss from 'pg-boss';
import { getAllTenants, getTenantAccounts, updateAccountSyncStatus } from './services/account-service.js';
import { writeAuditLog } from './services/audit-service.js';
import { assumeRole } from './services/sts-service.js';
import { runInventoryScan } from './services/scanner.js';
import { writeResourcesToPg, saveSyncStatus, reconcileStaleResources } from './services/pg-writer.js';
import { getTenantJobConfig } from '../scheduler/services/pg-service.js';
import { ensureStatelyScanQueue, dispatchTenantScan, DEAD_LETTER_QUEUE } from '../../lib/tenant-fanout.js';
import type { DiscoveryFanOutJob, DiscoveryScanJob } from './types.js';
import { readFileSync } from 'fs';
import { join, dirname, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../../lib/logger.js';
import { env } from '../../env.js';
import type { JobExecutor } from '../../executor/index.js';

const log = createLogger('discovery');

const __dirname = dirname(fileURLToPath(import.meta.url));

export function periodToMs(period: 'daily' | 'weekly' | 'monthly'): number {
    switch (period) {
        case 'daily':   return 24 * 60 * 60 * 1000;
        case 'weekly':  return 7 * 24 * 60 * 60 * 1000;
        case 'monthly': return 30 * 24 * 60 * 60 * 1000;
    }
}

export function shouldRunTenant(
    lastRunAt: string | null,
    period: 'daily' | 'weekly' | 'monthly'
): boolean {
    if (!lastRunAt) return true;
    return Date.now() - new Date(lastRunAt).getTime() >= periodToMs(period);
}

// Resolve the scanfile path cwd-independently: an absolute SCANFILE_PATH is used
// verbatim, a relative one is resolved against the module dir (not process.cwd(),
// which differs between `tsx` dev, `node dist` prod, and the local runner), and an
// unset value falls back to the scanfile.json shipped beside this module.
export function resolveScanfilePath(configured: string | undefined, baseDir: string): string {
    if (!configured) return join(baseDir, 'scanfile.json');
    return isAbsolute(configured) ? configured : join(baseDir, configured);
}

async function reconcileAndWarnIfEmpty(
    tenantId: string,
    accountId: string,
    scanId: string,
    resourceCount: number,
    scanError?: string,
): Promise<void> {
    let staleCount: number;
    try {
        staleCount = await reconcileStaleResources(tenantId, accountId, scanId);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error('Reconciliation failed — leaving previous isCurrent state in place (fail open)', {
            tenantId,
            accountId,
            scanId,
            error: msg,
        });
        return;
    }
    if (resourceCount === 0 && staleCount > 0) {
        log.warn('Reconciliation marked previously-current resources stale after an empty/failed scan', {
            tenantId,
            accountId,
            scanId,
            staleCount,
            ...(scanError ? { scanError } : {}),
        });
    }
}

function loadScanConfigs() {
    const scanfilePath = resolveScanfilePath(env.SCANFILE_PATH, __dirname);
    return JSON.parse(readFileSync(scanfilePath, 'utf-8'));
}

export async function handleDiscoveryScan(jobData: unknown): Promise<void> {
    const { tenantId, accountId, triggeredBy, correlationId } = jobData as DiscoveryScanJob;
    const scanId = `scan-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const startedAt = Date.now();
    const scanConfigs = loadScanConfigs();

    log.info('Starting scan', { tenantId, scanId, triggeredBy });

    await writeAuditLog({
        tenantId,
        eventType: 'inventory.discovery.scan_started',
        action: 'Discovery Scan Started',
        resourceId: scanId,
        status: 'info',
        severity: 'info',
        details: `Discovery scan started`,
        metadata: { scanId, triggeredBy },
    });

    const accounts = await getTenantAccounts(tenantId);
    const targetAccounts = accountId
        ? accounts.filter(a => a.accountId === accountId)
        : accounts;

    let totalResources = 0;
    let accountsSynced = 0;
    const errors: string[] = [];

    for (const account of targetAccounts) {
        try {
            log.debug('Scanning account', { tenantId, accountId: account.accountId, regions: account.regions });

            const credentials = await assumeRole(account.roleArn, account.accountId, account.regions?.[0] ?? 'ap-south-1', account.externalId);
            const regions = Array.isArray(account.regions) ? account.regions : [account.regions];

            const result = await runInventoryScan(credentials, regions, scanConfigs);
            totalResources += result.resources.length;

            await writeResourcesToPg(result.resources, tenantId, account.accountId, scanId);
            await reconcileAndWarnIfEmpty(tenantId, account.accountId, scanId, result.resources.length);
            await updateAccountSyncStatus(tenantId, account.accountId, {
                lastSyncedAt: new Date().toISOString(),
                lastSyncStatus: (result.errors?.length ?? 0) > 0 ? 'partial' : 'success',
                lastSyncResourceCount: result.resources.length,
            });

            accountsSynced++;
            if (result.errors?.length) errors.push(...result.errors);

            log.info('Account scan complete', {
                tenantId,
                accountId: account.accountId,
                resourceCount: result.resources.length,
                hasErrors: (result.errors?.length ?? 0) > 0,
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`Account ${account.accountId}: ${msg}`);
            log.error('Account scan failed', { tenantId, accountId: account.accountId, error: msg });

            await reconcileAndWarnIfEmpty(tenantId, account.accountId, scanId, 0, msg);
            await updateAccountSyncStatus(tenantId, account.accountId, {
                lastSyncedAt: new Date().toISOString(),
                lastSyncStatus: 'error',
                lastSyncResourceCount: 0,
                lastSyncError: msg,
            });
        }
    }

    const duration = Date.now() - startedAt;
    const status = errors.length > 0 && accountsSynced === 0 ? 'failed' : 'completed';

    await saveSyncStatus(scanId, totalResources, accountsSynced, tenantId, status, errors);

    await writeAuditLog({
        tenantId,
        eventType: `inventory.discovery.scan_${status}`,
        action: `Discovery Scan ${status === 'failed' ? 'Failed' : 'Completed'}`,
        resourceId: scanId,
        status: status === 'failed' ? 'error' : 'success',
        severity: status === 'failed' ? 'high' : 'info',
        details: `Discovery scan ${status}: ${totalResources} resources across ${accountsSynced} accounts`,
        metadata: { scanId, totalResources, accountsSynced, duration, errors },
    });

    if (status === 'failed') {
        log.error('Scan failed', {
            tenantId, scanId, totalResources, accountsSynced, duration, errorCount: errors.length,
        });
    } else {
        log.info('Scan completed', {
            tenantId, scanId, totalResources, accountsSynced, duration, errorCount: errors.length,
        });
    }

    if (errors.length > 0 && accountsSynced === 0) {
        throw new Error(`All accounts failed: ${errors.join('; ')}`);
    }
}

export async function register(boss: PgBoss, executor: JobExecutor): Promise<void> {
    executor.registerHandler?.('discovery-scan', handleDiscoveryScan);

    // createQueue uses ON CONFLICT DO NOTHING — expiry options are silently ignored on existing queues.
    // Always follow with updateQueue so expire_seconds is enforced even after worker restarts.
    await boss.createQueue('discovery-fan-out');
    await boss.updateQueue('discovery-fan-out', {
        name: 'discovery-fan-out',
        retryLimit: 1,
        expireInSeconds: 300, // 5 min — fan-out is fast
        deadLetter: DEAD_LETTER_QUEUE,
    });

    // discovery-scan: stately (1 job per tenant singletonKey per state), dead-lettered.
    // Discovery is read-only inventory scanning, so retries are safe (retryLimit:2).
    await ensureStatelyScanQueue(boss, 'discovery-scan', log, {
        expireInSeconds: 1800,
        retryLimit: 2,
    });

    // Once a day at midnight UTC
    await boss.schedule('discovery-fan-out', '0 0 * * *', {}, { tz: 'UTC' });

    // Fan-out: one discovery-scan job per tenant, atomically gated by per-tenant period.
    await boss.work<DiscoveryFanOutJob>(
        'discovery-fan-out',
        { batchSize: 1 },
        async ([job]) => {
            log.info('Fan-out triggered', { jobId: job.id });
            const tenants = await getAllTenants();
            let dispatched = 0;
            for (const tenant of tenants) {
                const config = await getTenantJobConfig(tenant.id, 'discovery-cron');
                const outcome = await dispatchTenantScan({
                    boss,
                    scanQueue: 'discovery-scan',
                    tenantId: tenant.id,
                    jobType: 'discovery-cron',
                    minIntervalMs: periodToMs(config.period),
                    payload: { type: 'scan', tenantId: tenant.id, triggeredBy: 'cron' } satisfies DiscoveryScanJob,
                    log,
                    sendOptions: { retryLimit: 2, retryDelay: 60, retryBackoff: true },
                });
                if (outcome === 'dispatched') dispatched++;
            }
            log.info('Fan-out complete', { tenantCount: tenants.length, dispatched });
        }
    );

    // Scan: scan all accounts for one tenant — delegates through executor
    await boss.work<DiscoveryScanJob>('discovery-scan', { batchSize: 1 }, async ([job]) => {
        await executor.execute('discovery-scan', job.data, {
            idempotencyKey: job.id,
            timeoutMs: (1800 - 60) * 1000, // below the 1800s queue expiry
        });
    });

    log.info('Registered queues', { queues: ['discovery-fan-out', 'discovery-scan'], cron: '0 0 * * *' });
}
