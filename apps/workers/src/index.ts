import { createBoss } from './boss.js';
import { createExecutor } from './executor/index.js';
import { createLogger } from './lib/logger.js';
import { register as registerSchedulerJobs } from './jobs/scheduler/index.js';
import { register as registerKbSyncJobs } from './jobs/kb-sync/index.js';
import { register as registerDiscoveryJobs } from './jobs/discovery/index.js';
import { register as registerAgentOpsJobs } from './jobs/agent-ops-scheduler/index.js';
import { register as registerCertificateExpiryMonitorJobs } from './jobs/certificate-expiry-monitor/index.js';
import { register as registerRightSizingPricingRefresh } from './jobs/right-sizing/pricing-refresh.js';
import { register as registerRightSizingJobs } from './jobs/right-sizing/index.js';
import { env } from './env.js';

const log = createLogger('workers');
const boss = createBoss();
const executor = createExecutor(env.WORKER_ARCH ?? 'vertical');

async function main() {
  log.info('Starting pg-boss...');

  boss.on('error', (error) => {
    log.error('pg-boss error', { error: String(error) });
  });

  await boss.start();
  log.info('pg-boss started');

  await registerSchedulerJobs(boss, executor);
  await registerKbSyncJobs(boss, executor);
  await registerDiscoveryJobs(boss, executor);
  await registerAgentOpsJobs(boss, executor);

  await registerCertificateExpiryMonitorJobs(boss, executor);
  await registerRightSizingPricingRefresh(boss, executor);
  await registerRightSizingJobs(boss, executor);

  log.info('All jobs registered. Waiting for work...');

  const shutdown = async (signal: string) => {
    log.info(`Received ${signal}, shutting down...`);
    await boss.stop({ graceful: true, timeout: 30000 });
    log.info('pg-boss stopped');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  log.error('Fatal error', { error: String(err) });
  process.exit(1);
});
