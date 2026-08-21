// workers/src/job-runner.ts
// Standalone entrypoint for running a single job handler by name.
// Used by ECS Fargate ephemeral tasks: node dist/job-runner.js --job <name> --data '<json>'
// Does NOT require pg-boss — imports handler functions directly.

import { VerticalExecutor } from './executor/index.js';
import { createLogger } from './lib/logger.js';
import { handleSchedulerJob } from './jobs/scheduler/index.js';
import { handleDiscoveryScan } from './jobs/discovery/index.js';
import { handleKbSyncJob } from './jobs/kb-sync/index.js';
import { handleAgentOpsTick } from './jobs/agent-ops-scheduler/index.js';
import { handleCertificateExpiryMonitor } from './jobs/certificate-expiry-monitor/index.js';
import { handleScan as handleRightSizingScan } from './jobs/right-sizing/index.js';
import { handlePricingRefresh } from './jobs/right-sizing/pricing-refresh.js';
import {
    handleSpotGuardRestoreScan,
    handleSpotGuardReport,
    handleSpotGuardObserveScan,
} from './jobs/spot-guard/index.js';
import { handleScan as handleScalingAuditScan } from './jobs/scaling-audit/index.js';
import { handleScan as handleCapacityPlanningScan } from './jobs/capacity-planning/index.js';

const log = createLogger('job-runner');

// Well-known job name → handler mapping
const HANDLERS: Record<string, (jobData: unknown) => Promise<unknown>> = {
    'scheduler-scan': handleSchedulerJob,
    'discovery-scan': handleDiscoveryScan,
    'kb-sync': handleKbSyncJob,
    'certificate-expiry-monitor': handleCertificateExpiryMonitor,
    'right-sizing-scan': handleRightSizingScan,
    'right-sizing-pricing-refresh': handlePricingRefresh,
    // Single agent-ops tick queue (sweeper design — see agent-ops-scheduler/index.ts).
    'agent-ops-tick': handleAgentOpsTick,
    // Fargate Spot Guard — ONLY the per-tenant restore scan belongs here.
    //
    // 'spot-guard-event' and 'spot-guard-bus-policy-reconcile' are DELIBERATELY ABSENT.
    // They run in-process in the long-lived workers service (see the executor-bypass
    // rationale in jobs/spot-guard/index.ts): dispatching one ephemeral Fargate task per
    // ECS event would cost roughly $9.5k/month at 50 accounts and would miss the ~2
    // minute Spot interruption window every time. Their absence is the enforcement — if
    // someone later routes them through the executor, the ephemeral task fails loudly on
    // an unknown job name rather than quietly burning money. Do not "complete" this map.
    'spot-guard-restore-scan': handleSpotGuardRestoreScan,
    'spot-guard-report-scan': handleSpotGuardReport,
    // Read-only hourly re-observation. Executor-routed like the two above: it fans out over a
    // whole tenant estate, which is the other side of the dividing line described above.
    'spot-guard-observe-scan': handleSpotGuardObserveScan,
    'scaling-audit-scan': handleScalingAuditScan,
    'capacity-planning-scan': handleCapacityPlanningScan,
};

function parseArgs(): { job: string; data: unknown } {
    const args = process.argv.slice(2);
    const jobIdx = args.indexOf('--job');
    const dataIdx = args.indexOf('--data');

    if (jobIdx === -1 || jobIdx + 1 >= args.length) {
        console.error('Usage: job-runner --job <name> [--data \'<json>\']');
        process.exit(1);
    }

    const job = args[jobIdx + 1];
    let data: unknown = {};
    if (dataIdx !== -1 && dataIdx + 1 < args.length) {
        try {
            data = JSON.parse(args[dataIdx + 1]);
        } catch {
            console.error(`Invalid JSON for --data: ${args[dataIdx + 1]}`);
            process.exit(1);
        }
    }

    return { job, data };
}

async function main(): Promise<void> {
    const { job, data } = parseArgs();
    log.info('Starting job-runner', { job });

    const executor = new VerticalExecutor();

    // Register well-known handlers
    for (const [name, handler] of Object.entries(HANDLERS)) {
        executor.registerHandler(name, handler);
    }

    await executor.execute(job, data);
    log.info('Job-runner complete', { job });
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        log.error('Job-runner failed', { error: err instanceof Error ? err.message : String(err) });
        process.exit(1);
    });
