// workers/src/jobs/discovery/local-runner.ts
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { runInventoryScan } from './services/scanner.js';
import { writeResourcesToPg, saveSyncStatus } from './services/pg-writer.js';
import { getAllTenants, getTenantAccounts } from './services/account-service.js';
import { assumeRole } from './services/sts-service.js';
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

    for (const account of targets) {
      const regions = opts.regions ?? (Array.isArray(account.regions) ? account.regions : [account.regions]);
      console.log(`Scanning account ${account.accountId} in regions: ${regions.join(', ')}`);
      const credentials = await assumeRole(account.roleArn, account.accountId, regions[0], account.externalId);
      const result = await runInventoryScan(credentials, regions, scanConfigs);
      console.log(`Found ${result.resources.length} resources in ${result.elapsedMs}ms`);
      if (result.errors?.length) console.warn('Errors:', result.errors);
      await writeResourcesToPg(result.resources, opts.tenantId, account.accountId, scanId);
    }
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
    }
  }

  console.log('Done.');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
