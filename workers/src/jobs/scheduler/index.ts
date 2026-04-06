import type PgBoss from 'pg-boss';
import { runFullScan, runPartialScan } from './services/scheduler-service.js';
import { getActiveTenants, getTenantSchedulerCron, DEFAULT_SCHEDULER_CRON } from './services/pg-service.js';
import type { SchedulerEvent } from './types/index.js';

const USE_PG_SCHEDULES = process.env.USE_PG_SCHEDULES === 'true';

export async function register(boss: PgBoss): Promise<void> {
  if (USE_PG_SCHEDULES) {
    // Per-tenant scheduling: each tenant gets its own queue with its configured cron
    const tenants = await getActiveTenants();
    console.log(`[scheduler] Scheduling ${tenants.length} tenant queues`);

    for (const tenant of tenants) {
      const queueName = `scheduler-scan-${tenant.id}`;
      const cron = await getTenantSchedulerCron(tenant.id);

      await boss.createQueue(queueName);
      await boss.schedule(queueName, cron, { tenantId: tenant.id }, { tz: 'UTC' });

      await boss.work<SchedulerEvent>(
        queueName,
        { batchSize: 1 },
        async (jobs) => {
          for (const job of jobs) {
            const event = { ...job.data, tenantId: tenant.id };
            const isPartialScan = event?.scheduleId || event?.scheduleName;
            const triggeredBy = event?.triggeredBy || 'system';

            console.log(`[scheduler] Processing job ${job.id} for tenant ${tenant.id}`, {
              mode: isPartialScan ? 'partial' : 'full',
              triggeredBy,
            });

            if (isPartialScan) {
              const result = await runPartialScan(event, triggeredBy);
              console.log(`[scheduler] Partial scan complete for tenant ${tenant.id}`, result);
            } else {
              const result = await runFullScan(triggeredBy);
              console.log(`[scheduler] Full scan complete for tenant ${tenant.id}`, result);
            }
          }
        },
      );

      console.log(`[scheduler] Registered queue ${queueName} with cron: ${cron}`);
    }
  } else {
    // Fallback: single global queue with default cron (DynamoDB mode)
    await boss.createQueue('scheduler-scan');
    await boss.schedule('scheduler-scan', DEFAULT_SCHEDULER_CRON, {}, { tz: 'UTC' });

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

    console.log(`[scheduler] Registered global scheduler-scan with cron: ${DEFAULT_SCHEDULER_CRON}`);
  }
}
