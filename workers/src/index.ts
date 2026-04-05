import { createBoss } from './boss.js';
import { register as registerSchedulerJobs } from './jobs/scheduler/index.js';
import { register as registerKbSyncJobs } from './jobs/kb-sync/index.js';

const boss = createBoss();

async function main() {
  console.log('[workers] Starting pg-boss...');

  boss.on('error', (error) => {
    console.error('[workers] pg-boss error:', error);
  });

  await boss.start();
  console.log('[workers] pg-boss started');

  await registerSchedulerJobs(boss);
  await registerKbSyncJobs(boss);

  console.log('[workers] All jobs registered. Waiting for work...');

  const shutdown = async (signal: string) => {
    console.log(`[workers] Received ${signal}, shutting down...`);
    await boss.stop({ graceful: true, timeout: 30000 });
    console.log('[workers] pg-boss stopped');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[workers] Fatal error:', err);
  process.exit(1);
});
