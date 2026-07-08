// workers/src/jobs/scheduler/local-runner.ts
//
// Standalone CLI to run the cost scheduler locally against real AWS + the local
// database — for a single schedule (partial scan) or all active schedules of a
// tenant / everything (full scan). Mirrors jobs/discovery/local-runner.ts.
//
// SAFETY: defaults to DRY RUN — it performs read-only Describe + decision logic
// and prints what it WOULD do, without any Start/Stop/Update mutation. Pass
// --execute to perform real mutations.
//
// Usage (from apps/workers):
//   bun run scheduler:local -- --schedule-id=<id> [--tenant-id=<id>]      # one schedule (dry run)
//   bun run scheduler:local -- --full [--tenant-id=<id>]                  # all active schedules (dry run)
//   bun run scheduler:local -- --full --tenant-id=<id> --execute          # REAL start/stop for a tenant
//   bun run scheduler:local -- --schedule-id=<id> --force-action=stop     # override time window
//   flags: --execute (real mutations)  --force-action=start|stop  --verbose
//
// Env: DATABASE_URL, AWS_PROFILE/creds, AWS_REGION. USE_PG_SCHEDULES should be 'true'.

import { runFullScan, runPartialScan } from './services/scheduler-service.js';
import { getScheduleTenantId, closePool } from './services/pg-service.js';
import { logger } from './utils/logger.js';
import type { SchedulerResult } from './types/index.js';

function parseArgs() {
    const args = process.argv.slice(2);
    const get = (flag: string) => {
        const entry = args.find((a) => a.startsWith(`--${flag}=`));
        return entry ? entry.split('=').slice(1).join('=') : undefined;
    };
    const forceAction = get('force-action');
    return {
        scheduleId: get('schedule-id'),
        tenantId: get('tenant-id'),
        full: args.includes('--full'),
        execute: args.includes('--execute'),
        forceAction: forceAction === 'start' || forceAction === 'stop' ? forceAction : undefined,
        verbose: args.includes('--verbose'),
    };
}

function printSummary(title: string, dryRun: boolean, result: SchedulerResult) {
    const line = '='.repeat(60);
    console.log(`\n${line}`);
    console.log(`  ${title}  ${dryRun ? '[DRY RUN — no AWS mutations]' : '[EXECUTE — real mutations]'}`);
    console.log(line);
    console.log(`  Execution ID       : ${result.executionId}`);
    console.log(`  Mode               : ${result.mode}`);
    console.log(`  Overall success    : ${result.success}`);
    console.log(`  Schedules processed: ${result.schedulesProcessed}`);
    console.log(`  Resources started  : ${result.resourcesStarted}`);
    console.log(`  Resources stopped  : ${result.resourcesStopped}`);
    console.log(`  Resources failed   : ${result.resourcesFailed}`);
    console.log(`  Duration           : ${result.duration}ms`);
    if (result.processedTenantIds?.length) {
        console.log(`  Tenants with work  : ${result.processedTenantIds.join(', ')}`);
    }
    const errors = result.errors ?? [];
    if (errors.length > 0) {
        console.log(`\n  ERRORS (${errors.length}):`);
        for (const e of errors) console.log(`    - ${e}`);
    } else {
        console.log(`\n  ERRORS: none`);
    }
    console.log(`${line}\n`);
}

async function main() {
    const opts = parseArgs();

    // Runtime toggles read by the scheduler at scan time (see scheduler-service.ts).
    const dryRun = !opts.execute;
    if (dryRun) process.env.SCHEDULER_DRY_RUN = 'true';
    else delete process.env.SCHEDULER_DRY_RUN;
    if (opts.forceAction) process.env.SCHEDULER_FORCE_ACTION = opts.forceAction;
    if (opts.verbose) logger.setLevel('debug');

    if (!opts.scheduleId && !opts.full) {
        console.error('Usage: scheduler:local --schedule-id=<id> [--tenant-id=<id>]  |  --full [--tenant-id=<id>]');
        console.error('       optional: --execute  --force-action=start|stop  --verbose');
        process.exit(1);
    }

    console.log(
        `[scheduler:local] Starting — mode=${opts.full ? 'full' : 'partial'}, ` +
        `${dryRun ? 'DRY RUN' : 'EXECUTE'}${opts.forceAction ? `, force-action=${opts.forceAction}` : ''}` +
        `${opts.tenantId ? `, tenant=${opts.tenantId}` : ''}${opts.scheduleId ? `, schedule=${opts.scheduleId}` : ''}`
    );

    if (opts.full) {
        const result = await runFullScan('web-ui', opts.tenantId);
        printSummary('FULL SCAN SUMMARY', dryRun, result);
        return;
    }

    // Partial scan for a single schedule. Resolve tenant if not supplied.
    let tenantId = opts.tenantId;
    if (!tenantId && opts.scheduleId) {
        tenantId = (await getScheduleTenantId(opts.scheduleId)) ?? undefined;
        if (!tenantId) {
            console.error(`[scheduler:local] Could not resolve tenant for schedule ${opts.scheduleId} (does it exist?)`);
            process.exit(1);
        }
        console.log(`[scheduler:local] Resolved tenant ${tenantId} for schedule ${opts.scheduleId}`);
    }

    const result = await runPartialScan(
        { scheduleId: opts.scheduleId, tenantId, triggeredBy: 'web-ui', userEmail: 'local-runner@nucleus' },
        'web-ui'
    );
    printSummary('PARTIAL SCAN SUMMARY', dryRun, result);
}

main()
    .then(async () => {
        await closePool();
        process.exit(0);
    })
    .catch(async (err) => {
        console.error('\n[scheduler:local] FATAL:', err instanceof Error ? err.stack || err.message : String(err));
        await closePool();
        process.exit(1);
    });
