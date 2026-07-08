import type PgBoss from 'pg-boss';
import { createLogger } from '../../lib/logger.js';
import type { JobExecutor } from '../../executor/index.js';
import { runFullScan, runPartialScan } from './services/scheduler-service.js';
import { getActiveTenants, getTenantJobConfig, updateTenantJobLastRun } from './services/pg-service.js';
import type { SchedulerEvent } from './types/index.js';

const log = createLogger('scheduler');

const JOB_NAME = 'scheduler-scan';

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
        // per-tenant cron tick) scope the scan to that tenant; otherwise scan all.
        const result = await runFullScan(triggeredBy, event?.tenantId);
        log.info('Full scan complete', { result });
        return result;
    }
}

export async function register(boss: PgBoss, executor: JobExecutor): Promise<void> {
    executor.registerHandler?.(JOB_NAME, handleSchedulerJob);

    await boss.createQueue(JOB_NAME);
    // A scan MUTATES live AWS resources (start/stop). If the worker is killed
    // mid-scan the job is orphaned in 'active'; under the global defaults
    // (expireInHours: 4, retryLimit: 3) pg-boss would resurrect and re-run it up
    // to 4 hours later — firing stale start/stop commands at an unexpected time.
    // For this queue that is unsafe, so:
    //   retryLimit: 0     → an interrupted/failed scan is DISCARDED, never re-run
    //                       (the next cron tick or manual trigger re-evaluates state).
    //   expireInSeconds   → bounds how long an orphaned 'active' job lingers before
    //                       pg-boss fails it. This value also caps the handler runtime
    //                       (pg-boss derives the handler timeout from it), so it must
    //                       comfortably exceed the longest legitimate scan.
    // createQueue uses ON CONFLICT DO NOTHING, so updateQueue enforces it on the
    // pre-existing queue too (matches the discovery/right-sizing pattern).
    await boss.updateQueue(JOB_NAME, { name: JOB_NAME, retryLimit: 0, expireInSeconds: 900 });

    // Global tick — every 5 min (matches minimum supported tenant interval)
    await boss.schedule(JOB_NAME, '*/5 * * * *', {}, { tz: 'UTC' });

    // batchSize: 1 prevents concurrent scans
    await boss.work<SchedulerEvent>(
        JOB_NAME,
        { batchSize: 1 },
        async (jobs) => {
            for (const job of jobs) {
                const data = (job.data || {}) as SchedulerEvent;

                // Manual trigger — a partial scan (scheduleId/scheduleName) or a
                // dashboard full-scan (triggeredBy 'web-ui'). Run immediately and
                // bypass per-tenant interval gating.
                if (data.triggeredBy === 'web-ui' || data.scheduleId || data.scheduleName) {
                    log.info('Manual scheduler trigger — running immediately', {
                        triggeredBy: data.triggeredBy,
                        scheduleId: data.scheduleId,
                        tenantId: data.tenantId,
                    });
                    await executor.execute(JOB_NAME, data);
                    continue;
                }

                // System cron tick ({} payload) — interval-gate EACH tenant and
                // scan only those due, scoped per tenant (respects per-tenant intervals).
                const tenants = await getActiveTenants();
                const now = Date.now();
                const runAt = new Date().toISOString();

                for (const tenant of tenants) {
                    const config = await getTenantJobConfig(tenant.id, 'scheduler-cron');
                    const thresholdMs = config.intervalMinutes * 60 * 1000;
                    const lastRun = config.lastRunAt ? new Date(config.lastRunAt).getTime() : 0;
                    if (now - lastRun < thresholdMs) {
                        log.info('Skipping tenant — interval not elapsed', {
                            tenantId: tenant.id,
                            intervalMinutes: config.intervalMinutes,
                            lastRunAt: config.lastRunAt,
                        });
                        continue;
                    }

                    // A single tenant's dispatch failing (e.g. a transient ECS/IAM error)
                    // must not abort the rest of the tenant loop or crash the worker
                    // process — pg-boss's handler callback has no outer catch, so an
                    // unhandled rejection here previously took the whole service down.
                    try {
                        await executor.execute(JOB_NAME, {
                            triggeredBy: 'system',
                            tenantId: tenant.id,
                        });
                    } catch (err) {
                        // Dispatch failed — do NOT advance lastRunAt, so the tenant is
                        // retried on the next tick.
                        log.error('Tenant scan dispatch failed — will retry next tick', {
                            tenantId: tenant.id,
                            error: err instanceof Error ? err.message : String(err),
                        });
                        continue;
                    }

                    // Advance lastRunAt on any SUCCESSFUL dispatch, regardless of whether
                    // the tenant had work. Do NOT gate this on the scan's return value:
                    // under WORKER_ARCH=horizontal, executor.execute() dispatches the scan
                    // to a separate ephemeral ECS task and resolves to `void` on exit 0 —
                    // the SchedulerResult (checkedTenantIds/processedTenantIds) is produced
                    // inside that task's process and never crosses back here. Gating on it
                    // left lastRunAt permanently null, so every tenant looked perpetually
                    // "due" and was re-dispatched (a real RunTask) on every cron tick.
                    // execute() resolves on success and throws on failure for BOTH the
                    // vertical (in-process) and horizontal (ECS) executors, so a clean
                    // resolve here is the correct, arch-independent "it ran" signal.
                    await updateTenantJobLastRun(tenant.id, 'scheduler-cron', runAt);
                }
            }
        },
    );

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

    log.info('Registered scheduler-scan job + cron + reschedule drain');
}
