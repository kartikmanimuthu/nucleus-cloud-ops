import type PgBoss from 'pg-boss';
import { runFullScan, runPartialScan } from './services/scheduler-service.js';
import type { SchedulerEvent } from './types/index.js';

export async function register(boss: PgBoss): Promise<void> {
  // Create queue first (required in pg-boss v10 before schedule/work)
  await boss.createQueue('scheduler-scan');

  // Register cron — every 30 minutes, enqueue a full scan job
  await boss.schedule('scheduler-scan', '*/30 * * * *', {}, {
    tz: 'UTC',
  });

  // Register worker — batchSize: 1 prevents concurrent full scans
  await boss.work<SchedulerEvent>(
    'scheduler-scan',
    { batchSize: 1 },
    async (jobs) => {
      for (const job of jobs) {
        const event = job.data;
        const isPartialScan = event?.scheduleId || event?.scheduleName;
        const triggeredBy = event?.triggeredBy || 'system';

        console.log(`[scheduler] Processing job ${job.id}`, {
          mode: isPartialScan ? 'partial' : 'full',
          triggeredBy,
        });

        if (isPartialScan) {
          const result = await runPartialScan(event, triggeredBy);
          console.log(`[scheduler] Partial scan complete`, result);
        } else {
          const result = await runFullScan(triggeredBy);
          console.log(`[scheduler] Full scan complete`, result);
        }
      }
    },
  );

  console.log('[scheduler] Registered scheduler-scan job + cron');
}
