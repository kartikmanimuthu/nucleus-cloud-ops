import type PgBoss from 'pg-boss';
import { createLogger } from '../../lib/logger.js';
import type { JobExecutor } from '../../executor/index.js';
import { runFullScan, runPartialScan } from './services/scheduler-service.js';
import { getActiveTenants, getTenantSchedulerConfig } from './services/pg-service.js';
import type { SchedulerEvent } from './types/index.js';

const log = createLogger('scheduler');

const JOB_NAME = 'scheduler-scan';

export async function handleSchedulerJob(jobData: unknown): Promise<void> {
  const event = jobData as SchedulerEvent | undefined;
  const isPartialScan = event?.scheduleId || event?.scheduleName;
  const triggeredBy = event?.triggeredBy || 'system';

  log.info('Processing scheduler job', {
    mode: isPartialScan ? 'partial' : 'full',
    triggeredBy,
  });

  if (isPartialScan) {
    const result = await runPartialScan(event as SchedulerEvent, triggeredBy);
    log.info('Partial scan complete', { result });
  } else {
    const result = await runFullScan(triggeredBy);
    log.info('Full scan complete', { result });
  }
}

export async function register(boss: PgBoss, executor: JobExecutor): Promise<void> {
  // Register handler with executor (used by VerticalExecutor for in-process dispatch)
  executor.registerHandler?.(JOB_NAME, handleSchedulerJob);

  // Create queue first (required in pg-boss v10 before schedule/work)
  await boss.createQueue(JOB_NAME);

  // Register cron — every 30 minutes, enqueue a full scan job
  await boss.schedule(JOB_NAME, '*/30 * * * *', {}, {
    tz: 'UTC',
  });

  // Register worker — batchSize: 1 prevents concurrent full scans
  await boss.work<SchedulerEvent>(
    JOB_NAME,
    { batchSize: 1 },
    async (jobs) => {
      for (const job of jobs) {
        await executor.execute(JOB_NAME, job.data);
      }
    },
  );

  log.info('Registered scheduler-scan job + cron');
}
