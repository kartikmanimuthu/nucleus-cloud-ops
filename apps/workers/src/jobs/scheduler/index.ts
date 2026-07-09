import type PgBoss from 'pg-boss';
import { createLogger } from '../../lib/logger.js';
import type { JobExecutor } from '../../executor/index.js';
import { runFullScan, runPartialScan } from './services/scheduler-service.js';
import { getActiveTenants, getTenantJobConfig } from './services/pg-service.js';
import { ensureStatelyScanQueue, dispatchTenantScan } from '../../lib/tenant-fanout.js';
import type { SchedulerEvent } from './types/index.js';

const log = createLogger('scheduler');

const JOB_NAME = 'scheduler-scan';
const FAN_OUT = 'scheduler-fan-out';

// A scan MUTATES live AWS resources (start/stop). retryLimit:0 → an interrupted scan
// is DISCARDED, never resurrected hours later to fire stale start/stop commands; the
// next cron tick re-evaluates state. expireInSeconds caps handler runtime and now
// bounds ONE tenant's scan (not the whole tenant loop), so it is meaningful again.
const SCAN_EXPIRE_SECONDS = 900;

export async function handleSchedulerJob(jobData: unknown) {
    const event = jobData as SchedulerEvent | undefined;
    const isPartialScan = event?.scheduleId || event?.scheduleName;
    const triggeredBy = event?.triggeredBy || 'system';

    log.info('Processing scheduler job', {
        mode: isPartialScan ? 'partial' : 'full',
        triggeredBy,
        tenantId: event?.tenantId,
    });

    if (isPartialScan) {
        const result = await runPartialScan(event as SchedulerEvent, triggeredBy);
        log.info('Partial scan complete', { result });
        return result;
    } else {
        // Full scan: when a tenantId is supplied (manual dashboard trigger or a
        // per-tenant fan-out job) scope the scan to that tenant; otherwise scan all.
        const result = await runFullScan(triggeredBy, event?.tenantId);
        log.info('Full scan complete', { result });
        return result;
    }
}

export async function register(boss: PgBoss, executor: JobExecutor): Promise<void> {
    executor.registerHandler?.(JOB_NAME, handleSchedulerJob);

    // Per-tenant scan queue (stately, bounded, dead-lettered). Handles BOTH the
    // fanned-out system scans (singletonKey `tenant:<id>`) and the manual "Execute
    // Now" / "run schedule now" triggers sent from web-ui (singletonKey
    // `manual:<...>`). Distinct singleton buckets mean a system scan never
    // suppresses a user's manual action and vice-versa — and, critically, one
    // tenant's manual scan never suppresses ANOTHER tenant's.
    await ensureStatelyScanQueue(boss, JOB_NAME, log, {
        expireInSeconds: SCAN_EXPIRE_SECONDS,
        retryLimit: 0,
    });

    // Fan-out queue: the cron tick lands here and does ONLY cheap gate+enqueue work
    // (milliseconds per tenant). This is the fix for the old design where the cron
    // handler ran the whole tenant loop inline — under WORKER_ARCH=horizontal each
    // tenant dispatch blocked the single work() slot for the full lifetime of an
    // ephemeral Fargate task, so with more than a handful of tenants one tick blew
    // past expireInSeconds, pg-boss freed the stately cron bucket, and the NEXT tick
    // started a second concurrent loop → duplicate RunTask per tenant → duplicate
    // start/stop against customer AWS. Fanning out makes overlap structurally
    // impossible (per-tenant singleton) and makes throughput scale with replicas.
    await boss.createQueue(FAN_OUT);
    await boss.updateQueue(FAN_OUT, { name: FAN_OUT, retryLimit: 1, expireInSeconds: 300 });

    // Retire the legacy cron that used to fire directly on scheduler-scan
    // (singletonKey 'scheduler-cron'); the fan-out queue owns the cron now.
    try {
        await boss.unschedule(JOB_NAME);
    } catch { /* no prior schedule — fine */ }

    // Global tick every 5 min (matches the minimum supported tenant interval).
    await boss.schedule(FAN_OUT, '*/5 * * * *', {}, { tz: 'UTC', singletonKey: 'scheduler-cron' });

    // Fan-out handler — gate each tenant atomically and enqueue only those due.
    await boss.work(FAN_OUT, { batchSize: 1 }, async () => {
        const tenants = await getActiveTenants();
        let dispatched = 0;
        for (const tenant of tenants) {
            const config = await getTenantJobConfig(tenant.id, 'scheduler-cron');
            const outcome = await dispatchTenantScan({
                boss,
                scanQueue: JOB_NAME,
                tenantId: tenant.id,
                jobType: 'scheduler-cron',
                minIntervalMs: config.intervalMinutes * 60 * 1000,
                payload: { triggeredBy: 'system', tenantId: tenant.id } satisfies SchedulerEvent,
                log,
                sendOptions: { retryLimit: 0, expireInSeconds: SCAN_EXPIRE_SECONDS },
            });
            if (outcome === 'dispatched') dispatched++;
        }
        log.info('Scheduler fan-out complete', { tenantCount: tenants.length, dispatched });
    });

    // Scan consumer — runs one tenant's scan (system) or a manual trigger.
    // batchSize:1 keeps a single scan per worker slot.
    await boss.work<SchedulerEvent>(JOB_NAME, { batchSize: 1 }, async (jobs) => {
        for (const job of jobs) {
            await executor.execute(JOB_NAME, job.data || {}, {
                idempotencyKey: job.id,
                // Keep the executor timeout below the queue expiry so it stops a
                // leaked ECS task before pg-boss expires and retries the job.
                timeoutMs: (SCAN_EXPIRE_SECONDS - 60) * 1000,
            });
        }
    });

    // Drain the 'scheduler-reschedule' queue produced by the web-ui settings PUT.
    // The interval is read from tenant_configs on every cron tick, so this message
    // is informational only — consume it so it does not pile up unconsumed.
    await boss.createQueue('scheduler-reschedule');
    await boss.work('scheduler-reschedule', { batchSize: 1 }, async (jobs) => {
        for (const job of jobs) {
            log.info('scheduler-reschedule received (interval read from tenant_configs each tick; no-op drain)', {
                data: job.data,
            });
        }
    });

    log.info('Registered scheduler fan-out + per-tenant scan + reschedule drain');
}
