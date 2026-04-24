import type PgBoss from 'pg-boss';
import { createLogger } from '../../lib/logger.js';
import type { JobExecutor } from '../../executor/index.js';
import { runFullScan, runPartialScan } from './services/scheduler-service.js';
import { getActiveTenants, getTenantJobConfig, updateTenantJobLastRun } from './services/pg-service.js';
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
    executor.registerHandler?.(JOB_NAME, handleSchedulerJob);

    await boss.createQueue(JOB_NAME);

    // Global tick — every hour (minimum granularity)
    await boss.schedule(JOB_NAME, '0 * * * *', {}, { tz: 'UTC' });

    await boss.work<SchedulerEvent>(
        JOB_NAME,
        async (jobs) => {
            const tenants = await getActiveTenants();
            for (const tenant of tenants) {
                const config = await getTenantJobConfig(tenant.id, 'scheduler-cron');
                const thresholdMs = config.intervalMinutes * 60 * 1000;
                const lastRun = config.lastRunAt ? new Date(config.lastRunAt).getTime() : 0;
                if (Date.now() - lastRun < thresholdMs) {
                    log.info('Skipping tenant — interval not elapsed', {
                        tenantId: tenant.id,
                        intervalMinutes: config.intervalMinutes,
                        lastRunAt: config.lastRunAt,
                    });
                    continue;
                }
                for (const job of jobs) {
                    await executor.execute(JOB_NAME, job.data);
                }
                await updateTenantJobLastRun(tenant.id, 'scheduler-cron', new Date().toISOString());
            }
        },
    );

    log.info('Registered scheduler-scan job + cron');
}
