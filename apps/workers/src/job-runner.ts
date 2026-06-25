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

const log = createLogger('job-runner');

const AGENT_OPS_PREFIX = 'agent-ops-task:';

// Well-known job name → handler mapping
const HANDLERS: Record<string, (jobData: unknown) => Promise<unknown>> = {
    'scheduler-scan': handleSchedulerJob,
    'discovery-scan': handleDiscoveryScan,
    'kb-sync': handleKbSyncJob,
    'certificate-expiry-monitor': handleCertificateExpiryMonitor,
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

    // Agent-ops uses dynamic queue names (agent-ops-task:<taskId>)
    // Register handleAgentOpsTick under the exact job name from --job arg
    if (job.startsWith(AGENT_OPS_PREFIX)) {
        executor.registerHandler(job, handleAgentOpsTick);
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
