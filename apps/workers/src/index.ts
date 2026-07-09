import { createBoss } from './boss.js';
import { createExecutor } from './executor/index.js';
import { createLogger } from './lib/logger.js';
import { startHealthServer, markReady } from './lib/health.js';
import type { Server } from 'node:http';
import { registerDeadLetterQueue, registerMonitoring, registerErrorTripwire } from './lib/observability.js';
import { register as registerSchedulerJobs } from './jobs/scheduler/index.js';
import { register as registerKbSyncJobs } from './jobs/kb-sync/index.js';
import { register as registerDiscoveryJobs } from './jobs/discovery/index.js';
import {
  register as registerAgentOpsJobs,
  stopAgentOpsSweeper,
  closeAgentOpsResources,
} from './jobs/agent-ops-scheduler/index.js';
import { register as registerCertificateExpiryMonitorJobs } from './jobs/certificate-expiry-monitor/index.js';
import { register as registerRightSizingPricingRefresh } from './jobs/right-sizing/pricing-refresh.js';
import { register as registerRightSizingJobs } from './jobs/right-sizing/index.js';
import { env } from './env.js';

const log = createLogger('workers');
const boss = createBoss();
const executor = createExecutor(env.WORKER_ARCH ?? 'vertical');

const HEALTH_PORT = parseInt(env.HEALTH_PORT ?? '8080', 10);
// monitor-states ticks every 30s (see boss.ts). Allow ~4 missed ticks before we
// declare the supervisor wedged, so a single slow tick does not flap the task.
const HEALTH_STALENESS_MS = 120_000;

let healthServer: Server | undefined;

// Register signal handlers BEFORE the long start-up awaits so a hang during
// registration is still interruptible by ECS/SIGTERM.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) {
        log.warn(`Received ${signal} again — shutdown already in progress`);
        return;
    }
    shuttingDown = true;
    log.info(`Received ${signal}, shutting down...`);
    // Stop scheduling new agent-ops ticks BEFORE draining, so the sweeper interval
    // cannot enqueue against a stopping boss during the drain window.
    stopAgentOpsSweeper();
    // Fail the health check immediately so ECS/LB stops routing to this task.
    healthServer?.close();
    try {
        // Give in-flight handlers time to finish. Must stay below the ECS task
        // stopTimeout (set to 120s in infra) so we drain cleanly before SIGKILL.
        await boss.stop({ graceful: true, timeout: 90_000 });
        log.info('pg-boss stopped');
        // After the drain, in-flight tick handlers are done — safe to close DB handles.
        await closeAgentOpsResources();
        process.exit(0);
    } catch (err) {
        log.error('Error during graceful shutdown', { error: err instanceof Error ? err.message : String(err) });
        process.exit(1);
    }
}
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });

async function main() {
    log.info('Starting pg-boss...');

    // Health server first so ECS gets a fast /live even while queues register.
    healthServer = startHealthServer({ port: HEALTH_PORT, stalenessMs: HEALTH_STALENESS_MS });

    // Error tripwire + monitoring replace the bare error log: sustained errors now
    // exit the process (ECS restarts), and monitor-states drives the heartbeat.
    registerErrorTripwire(boss, log, { threshold: 10, windowMs: 60_000 });
    registerMonitoring(boss, log);

    await boss.start();
    log.info('pg-boss started');

    // Dead-letter queue must exist before job queues that reference it by name.
    await registerDeadLetterQueue(boss, log);

    await registerSchedulerJobs(boss, executor);
    await registerKbSyncJobs(boss, executor);
    await registerDiscoveryJobs(boss, executor);
    await registerAgentOpsJobs(boss, executor);

    await registerCertificateExpiryMonitorJobs(boss, executor);
    await registerRightSizingPricingRefresh(boss, executor);
    await registerRightSizingJobs(boss, executor);

    markReady();
    log.info('All jobs registered. Waiting for work...');
}

main().catch((err) => {
    log.error('Fatal error', { error: String(err) });
    process.exit(1);
});
