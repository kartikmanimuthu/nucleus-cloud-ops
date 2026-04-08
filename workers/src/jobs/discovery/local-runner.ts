// workers/src/jobs/discovery/local-runner.ts
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { runInventoryScan } from './services/scanner.js';
import { writeResourcesToPg, saveSyncStatus } from './services/pg-writer.js';
import { getAllTenants, getTenantAccounts, updateAccountSyncStatus } from './services/account-service.js';
import { assumeRole } from './services/sts-service.js';
import { processAccountVectors } from './services/vector-processor.js';
import type { ScanConfig } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const entry = args.find(a => a.startsWith(`--${flag}=`));
    return entry ? entry.split('=').slice(1).join('=') : undefined;
  };
  return {
    tenantId: get('tenant-id'),
    accountId: get('account-id'),
    regions: get('regions')?.split(','),
    concurrentRegions: parseInt(get('concurrent-regions') ?? '5', 10),
    concurrentServices: parseInt(get('concurrent-services') ?? '10', 10),
    listServices: args.includes('--list-services'),
    verbose: args.includes('--verbose'),
  };
}

async function main() {
  const opts = parseArgs();

  if (opts.verbose) {
    process.env.LOG_LEVEL = 'debug';
  }

  const scanfilePath = process.env.SCANFILE_PATH ?? join(__dirname, 'scanfile.json');
  const scanConfigs: ScanConfig[] = JSON.parse(readFileSync(scanfilePath, 'utf-8'));

  if (opts.listServices) {
    console.log('Available services in scanfile:');
    for (const cfg of scanConfigs) {
      console.log(`  ${cfg.service}:${cfg.function}`);
    }
    process.exit(0);
  }

  process.env.CONCURRENT_REGIONS = String(opts.concurrentRegions);
  process.env.CONCURRENT_SERVICES = String(opts.concurrentServices);

  const scanId = `local-${Date.now()}`;

  if (opts.tenantId) {
    const accounts = await getTenantAccounts(opts.tenantId);
    const targets = opts.accountId ? accounts.filter(a => a.accountId === opts.accountId) : accounts;

    let totalResources = 0;
    let accountsSynced = 0;
    const errors: string[] = [];

    for (const account of targets) {
      const regions = opts.regions ?? (Array.isArray(account.regions) ? account.regions : [account.regions]);
      console.log(`Scanning account ${account.accountId} in regions: ${regions.join(', ')}`);
      try {
        const credentials = await assumeRole(account.roleArn, account.accountId, regions[0], account.externalId);
        const result = await runInventoryScan(credentials, regions, scanConfigs);
        console.log(`Found ${result.resources.length} resources in ${result.elapsedMs}ms`);
        if (result.errors?.length) {
          console.warn('Errors:', result.errors);
          errors.push(...result.errors);
        }
        await writeResourcesToPg(result.resources, opts.tenantId, account.accountId, scanId);
        totalResources += result.resources.length;

        await updateAccountSyncStatus(opts.tenantId, account.accountId, {
          lastSyncedAt: new Date().toISOString(),
          lastSyncStatus: (result.errors?.length ?? 0) > 0 ? 'partial' : 'success',
          lastSyncResourceCount: result.resources.length,
        });
        accountsSynced++;

        try {
          const vectorCount = await processAccountVectors(result.resources, account.accountId, opts.tenantId);
          console.log(`Vectorized ${vectorCount} resources for ${account.accountId}`);
        } catch (err) {
          console.warn(`Vector processing failed for ${account.accountId} (non-fatal):`, err instanceof Error ? err.message : err);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Account ${account.accountId}: ${msg}`);
        console.error(`Account scan failed for ${account.accountId}:`, msg);

        await updateAccountSyncStatus(opts.tenantId, account.accountId, {
          lastSyncedAt: new Date().toISOString(),
          lastSyncStatus: 'error',
          lastSyncResourceCount: 0,
          lastSyncError: msg,
        });
      }
    }

    const status = errors.length > 0 && accountsSynced === 0 ? 'failed' : 'completed';
    await saveSyncStatus(scanId, totalResources, accountsSynced, opts.tenantId, status, errors);
    console.log(`Sync status saved: ${status} — ${totalResources} resources across ${accountsSynced} accounts`);
  } else {
    // Direct mode: use AWS default credential chain (respects AWS_PROFILE, ~/.aws, instance profile)
    const regions = opts.regions ?? [process.env.AWS_REGION ?? 'ap-south-1'];
    // Pass undefined credentials so createClient uses the SDK default chain
    const defaultCredentials = { credentials: undefined as any, region: regions[0] };
    console.log(`Direct mode: scanning regions ${regions.join(', ')}`);
    const result = await runInventoryScan(defaultCredentials, regions, scanConfigs);
    console.log(`Found ${result.resources.length} resources in ${result.elapsedMs}ms`);
    if (result.errors?.length) console.warn('Errors:', result.errors);
    if (result.resources.length > 0 && process.env.DATABASE_URL) {
      const accountId = process.env.AWS_ACCOUNT_ID ?? 'local';
      const tenantId = process.env.TENANT_ID ?? 'local';
      await writeResourcesToPg(result.resources, tenantId, accountId, scanId);
      console.log(`Written ${result.resources.length} resources to PostgreSQL (tenant=${tenantId}, account=${accountId})`);
      try {
        const vectorCount = await processAccountVectors(result.resources, accountId, tenantId);
        console.log(`Vectorized ${vectorCount} resources for ${accountId}`);
      } catch (err) {
        console.warn(`Vector processing failed (non-fatal):`, err instanceof Error ? err.message : err);
      }
    }
  }

  console.log('Done.');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
