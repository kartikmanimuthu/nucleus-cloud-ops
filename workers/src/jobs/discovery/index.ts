// workers/src/jobs/discovery/index.ts
import type PgBoss from 'pg-boss';
import { getAllTenants, getTenantAccounts, updateAccountSyncStatus } from './services/account-service.js';
import { writeAuditLog } from './services/audit-service.js';
import { assumeRole } from './services/sts-service.js';
import { runInventoryScan } from './services/scanner.js';
import { writeResourcesToPg, saveSyncStatus } from './services/pg-writer.js';
import { processAccountVectors } from './services/vector-processor.js';
import type { DiscoveryFanOutJob, DiscoveryScanJob } from './types.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('discovery');

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadScanConfigs() {
  const scanfilePath = process.env.SCANFILE_PATH ?? join(__dirname, 'scanfile.json');
  return JSON.parse(readFileSync(scanfilePath, 'utf-8'));
}

export async function register(boss: PgBoss): Promise<void> {
  // createQueue uses ON CONFLICT DO NOTHING — expiry options are silently ignored on existing queues.
  // Always follow with updateQueue so expire_seconds is enforced even after worker restarts.
  await boss.createQueue('discovery-fan-out');
  await boss.updateQueue('discovery-fan-out', {
    name: 'discovery-fan-out',
    retryLimit: 1,
    expireInSeconds: 300, // 5 min — fan-out is fast
  });

  // discovery-scan uses 'stately' policy: only 1 job per singletonKey per state (created OR active).
  // This prevents fan-out from piling up duplicate scan jobs for the same tenant.
  // Policy can't be changed via updateQueue, so we update it directly via SQL on first run.
  const existingQueue = await boss.getQueue('discovery-scan');
  if (!existingQueue) {
    await boss.createQueue('discovery-scan', {
      name: 'discovery-scan',
      policy: 'stately',
      expireInSeconds: 1800,
    });
  } else if (existingQueue.policy !== 'stately') {
    log.info('Migrating discovery-scan queue to stately policy', { oldPolicy: existingQueue.policy });
    const db = boss.getDb();
    // Clear all non-completed jobs so stately dedup starts clean
    await db.executeSql(`DELETE FROM pgboss.job WHERE name = 'discovery-scan' AND state NOT IN ('completed')`, []);
    // Update policy directly — updateQueue() doesn't support policy changes
    await db.executeSql(`UPDATE pgboss.queue SET policy = 'stately', updated_on = now() WHERE name = 'discovery-scan'`, []);
  }
  await boss.updateQueue('discovery-scan', {
    name: 'discovery-scan',
    expireInSeconds: 1800,
  });

  // Every 5 minutes
  await boss.schedule('discovery-fan-out', '*/5 * * * *', {}, { tz: 'UTC' });

  // Fan-out: one discovery-scan job per tenant
  await boss.work<DiscoveryFanOutJob>(
    'discovery-fan-out',
    { batchSize: 1 },
    async ([job]) => {
      log.info('Fan-out triggered', { jobId: job.id });
      const tenants = await getAllTenants();
      for (const tenant of tenants) {
        const jobId = await boss.send(
          'discovery-scan',
          { type: 'scan', tenantId: tenant.id, triggeredBy: 'cron' } satisfies DiscoveryScanJob,
          {
            singletonKey: `tenant:${tenant.id}`,
            retryLimit: 2,
            retryDelay: 60,
            retryBackoff: true,
          }
        );
        if (jobId === null) {
          log.warn('Scan job already queued or active, skipping', { tenantId: tenant.id });
        } else {
          log.debug('Scan job enqueued', { tenantId: tenant.id, jobId });
        }
      }
      log.info('Fan-out complete', { tenantCount: tenants.length });
    }
  );

  // Scan: scan all accounts for one tenant
  await boss.work<DiscoveryScanJob>(
    'discovery-scan',
    { batchSize: 1 },
    async ([job]) => {
      const { tenantId, accountId, triggeredBy, correlationId } = job.data;
      const scanId = `scan-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const startedAt = Date.now();
      const scanConfigs = loadScanConfigs();

      log.info('Starting scan', { jobId: job.id, tenantId, scanId, triggeredBy });

      await writeAuditLog({
        tenantId,
        eventType: 'discovery.scan.started',
        action: 'scan_started',
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
          await processAccountVectors(result.resources, account.accountId, tenantId);
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
        eventType: `discovery.scan.${status}`,
        action: `scan_${status}`,
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
  );

  log.info('Registered queues', { queues: ['discovery-fan-out', 'discovery-scan'], cron: '*/5 * * * *' });
}
