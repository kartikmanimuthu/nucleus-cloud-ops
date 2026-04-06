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

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadScanConfigs() {
  const scanfilePath = process.env.SCANFILE_PATH ?? join(__dirname, 'scanfile.json');
  return JSON.parse(readFileSync(scanfilePath, 'utf-8'));
}

export async function register(boss: PgBoss): Promise<void> {
  await boss.createQueue('discovery-fan-out', {
    retryLimit: 1,
    expireInMinutes: 5,
  });
  await boss.createQueue('discovery-scan', {
    expireInMinutes: 30,
  });

  // Daily cron at 2 AM UTC
  await boss.schedule('discovery-fan-out', '0 2 * * *', {}, { tz: 'UTC' });

  // Fan-out: one discovery-scan job per tenant
  await boss.work<DiscoveryFanOutJob>(
    'discovery-fan-out',
    { batchSize: 1 },
    async ([job]) => {
      console.log('[discovery] Fan-out triggered', { jobId: job.id });
      const tenants = await getAllTenants();
      for (const tenant of tenants) {
        await boss.send(
          'discovery-scan',
          { type: 'scan', tenantId: tenant.id, triggeredBy: 'cron' } satisfies DiscoveryScanJob,
          {
            singletonKey: `tenant:${tenant.id}`,
            expireInHours: 2,
            retryLimit: 2,
            retryDelay: 60,
            retryBackoff: true,
          }
        );
      }
      console.log('[discovery] Fan-out complete', { tenantCount: tenants.length });
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

      console.log('[discovery] Starting scan', { jobId: job.id, tenantId, scanId, triggeredBy });

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
          console.log('[discovery] Scanning account', { tenantId, accountId: account.accountId, regions: account.regions });

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

          console.log('[discovery] Account scan complete', {
            tenantId,
            accountId: account.accountId,
            resourceCount: result.resources.length,
            hasErrors: (result.errors?.length ?? 0) > 0,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`Account ${account.accountId}: ${msg}`);
          console.error('[discovery] Account scan failed', { tenantId, accountId: account.accountId, error: msg });
        }
      }

      await saveSyncStatus(scanId, totalResources, accountsSynced);

      const duration = Date.now() - startedAt;
      const status = errors.length > 0 && accountsSynced === 0 ? 'failed' : 'completed';

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

      console.log(`[discovery] Scan ${status}`, {
        tenantId, scanId, totalResources, accountsSynced, duration, errorCount: errors.length,
      });

      if (errors.length > 0 && accountsSynced === 0) {
        throw new Error(`All accounts failed: ${errors.join('; ')}`);
      }
    }
  );

  console.log('[discovery] Registered queues', { queues: ['discovery-fan-out', 'discovery-scan'], cron: '0 2 * * *' });
}
