import type PgBoss from 'pg-boss';
import { createLogger } from '../../lib/logger.js';
import type { JobExecutor } from '../../executor/index.js';
import { handleCertificateExpiryMonitor } from './handler.js';

const log = createLogger('certificate-expiry-monitor');

const JOB_NAME = 'certificate-expiry-monitor';

export { handleCertificateExpiryMonitor };

export async function register(boss: PgBoss, executor: JobExecutor): Promise<void> {
    executor.registerHandler?.(JOB_NAME, handleCertificateExpiryMonitor);

    await boss.createQueue(JOB_NAME);

    // Run daily at 02:17 UTC — staggered off the :00 mark so it does not contend
    // with discovery-fan-out (00:00) or the scheduler tick for the single work slot.
    await boss.schedule(JOB_NAME, '17 2 * * *', {}, { tz: 'UTC' });

    await boss.work(
        JOB_NAME,
        { batchSize: 1 },
        async (jobs) => {
            for (const job of jobs) {
                await executor.execute(JOB_NAME, job.data, { idempotencyKey: job.id });
            }
        },
    );

    log.info('Registered certificate-expiry-monitor job + daily cron');
}
