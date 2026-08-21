// workers/src/jobs/spot-guard/index.ts
//
// Fargate Spot Guard orchestrator (SG-006).
//
// Gated on SPOT_GUARD_ENABLED so the image ships everywhere while the behaviour only
// activates where the infrastructure exists (sbx today — see the spotGuardEnabled Pulumi
// config flag in infra/compute/index.ts).
import type PgBoss from 'pg-boss';
import { createLogger } from '../../lib/logger.js';
import type { JobExecutor } from '../../executor/index.js';
import { getAllTenants } from '../discovery/services/account-service.js';
import { ensureStatelyScanQueue, dispatchTenantScan, DEAD_LETTER_QUEUE } from '../../lib/tenant-fanout.js';
import { env } from '../../env.js';
import { SPOT_GUARD_CONFIG } from './config.js';
import { handleSpotGuardEvent } from './handlers/handle-spot-event.js';
import { handleSpotGuardRestoreScan } from './handlers/handle-restore-scan.js';
import { handleSpotGuardReport } from './handlers/handle-report-scan.js';
import { handleSpotGuardObserveScan } from './handlers/handle-observe-scan.js';
import { handleBusPolicyReconcile } from './bus-policy.js';
import { startSpotGuardConsumer, stopSpotGuardConsumer, SPOT_GUARD_EVENT_QUEUE } from './consumer.js';
import { closePool } from '../discovery/services/db.js';

const log = createLogger('spot-guard');

const EVENT = SPOT_GUARD_EVENT_QUEUE; // 'spot-guard-event'
const BUS_POLICY = 'spot-guard-bus-policy-reconcile';
const RESTORE_FAN_OUT = 'spot-guard-restore-fan-out';
const RESTORE_SCAN = 'spot-guard-restore-scan';
const REPORT_FAN_OUT = 'spot-guard-report-fan-out';
const REPORT_SCAN = 'spot-guard-report-scan';
const OBSERVE_FAN_OUT = 'spot-guard-observe-fan-out';
const OBSERVE_SCAN = 'spot-guard-observe-scan';

// Crons staggered off :00 AND off every multiple of 5, because scheduler-fan-out runs
// '*/5 * * * *' and would otherwise contend for the same work slot. Existing schedule
// map: scheduler */5, discovery 00:00, right-sizing 01:13, certs 02:17, pricing Sun 03:17.
const RESTORE_CRON = '23 * * * *'; // hourly at :23 — replaces the reference's cron(minute:0)
const BUS_POLICY_CRON = '7 * * * *'; // hourly safety net, so a dropped enqueue still converges
// 18:35 UTC = 00:05 IST — five minutes after the Asia/Kolkata day closes at 18:30 UTC, so the
// "day that just ended" window is complete for a tenant on that report timezone and the digest
// arrives as an end-of-day summary rather than the next morning.
//
// Was 00:41 UTC (06:11 IST), which reported a complete UTC day but landed at breakfast the
// following morning. The reference was worse still: it ran at 16:30 UTC and reported the CURRENT
// day, so its digest was always partial, while its own comment claimed 23:59.
//
// The cron is global while reportTimezone is per tenant, so this is right for IST-based tenants
// and shifts the arrival time for others. Set the matching timezone at
// Cost Optimization -> Spot Guard -> Settings, or the window and the send time disagree.
const REPORT_CRON = '35 18 * * *';
// Every 15 minutes, at :03/:18/:33/:48 — none of which is a multiple of 5 (scheduler-fan-out runs
// */5) nor :23 (the restore scan), so nothing contends for the same work slot.
//
// Was hourly. One DescribeServices per cluster per run, so four calls an hour for the sbx estate —
// and it bounds how long the console can disagree with AWS after a change made outside Nucleus to
// 15 minutes instead of 60. Changes made THROUGH Nucleus, and scale-ups, no longer wait for this
// pass at all: the enable path writes immediately and the task-event path now self-heals its counts.
const OBSERVE_CRON = '3,18,33,48 * * * *';

export {
    handleSpotGuardEvent,
    handleSpotGuardRestoreScan,
    handleSpotGuardReport,
    handleSpotGuardObserveScan,
    handleBusPolicyReconcile,
    stopSpotGuardConsumer,
};

/** Close module-owned DB handles. Call AFTER boss.stop() — in-flight handlers need them. */
export async function closeSpotGuardResources(): Promise<void> {
    await closePool();
}

export async function register(boss: PgBoss, executor: JobExecutor): Promise<void> {
    if (env.SPOT_GUARD_ENABLED !== 'true') {
        log.info('SPOT_GUARD_ENABLED is not "true" — Spot Guard not registered');
        return;
    }

    // ── Executor-routed: the normal repo pattern ──────────────────────────────
    executor.registerHandler?.(RESTORE_SCAN, handleSpotGuardRestoreScan);
    executor.registerHandler?.(REPORT_SCAN, handleSpotGuardReport);
    executor.registerHandler?.(OBSERVE_SCAN, handleSpotGuardObserveScan);

    await boss.createQueue(RESTORE_FAN_OUT);
    await boss.updateQueue(RESTORE_FAN_OUT, {
        name: RESTORE_FAN_OUT,
        retryLimit: 1,
        expireInSeconds: 300,
        deadLetter: DEAD_LETTER_QUEUE,
    });

    // retryLimit 0: this scan MUTATES live AWS compute (UpdateService +
    // forceNewDeployment). A retry would bounce production tasks a second time for the
    // same logical work; the next :23 tick is the retry. Matches scheduler-scan and is
    // deliberately unlike right-sizing-scan's retryLimit 2 (read-only analysis).
    await ensureStatelyScanQueue(boss, RESTORE_SCAN, log, { expireInSeconds: 900, retryLimit: 0 });
    await boss.schedule(RESTORE_FAN_OUT, RESTORE_CRON, {}, { tz: 'UTC' });

    await boss.work(RESTORE_FAN_OUT, { batchSize: 1 }, async () => {
        const tenants = await getAllTenants();
        let dispatched = 0;
        for (const tenant of tenants) {
            const outcome = await dispatchTenantScan({
                boss,
                scanQueue: RESTORE_SCAN,
                tenantId: tenant.id,
                jobType: 'spot-guard-restore-cron',
                minIntervalMs: SPOT_GUARD_CONFIG.restoreMinIntervalMs,
                payload: { tenantId: tenant.id, trigger: 'schedule' },
                log,
                sendOptions: { retryLimit: 0 },
            });
            if (outcome === 'dispatched') dispatched += 1;
        }
        log.info('Restore fan-out complete', { tenantCount: tenants.length, dispatched });
    });

    await boss.work(RESTORE_SCAN, { batchSize: 1 }, async ([job]) => {
        await executor.execute(RESTORE_SCAN, job.data, {
            idempotencyKey: job.id,
            timeoutMs: (900 - 60) * 1000, // stay below the queue's expireInSeconds
        });
    });

    // ── Daily hours report ────────────────────────────────────────────────────
    await boss.createQueue(REPORT_FAN_OUT);
    await boss.updateQueue(REPORT_FAN_OUT, {
        name: REPORT_FAN_OUT,
        retryLimit: 1,
        expireInSeconds: 300,
        deadLetter: DEAD_LETTER_QUEUE,
    });
    // retryLimit 2, unlike the restore scan's 0: this aggregation is READ-ONLY, so a retry
    // is free. Same reasoning as right-sizing-scan.
    await ensureStatelyScanQueue(boss, REPORT_SCAN, log, { expireInSeconds: 600, retryLimit: 2 });
    await boss.schedule(REPORT_FAN_OUT, REPORT_CRON, {}, { tz: 'UTC' });

    await boss.work(REPORT_FAN_OUT, { batchSize: 1 }, async () => {
        const tenants = await getAllTenants();
        let dispatched = 0;
        for (const tenant of tenants) {
            const outcome = await dispatchTenantScan({
                boss,
                scanQueue: REPORT_SCAN,
                tenantId: tenant.id,
                jobType: 'spot-guard-report-cron',
                minIntervalMs: SPOT_GUARD_CONFIG.reportMinIntervalMs,
                payload: { tenantId: tenant.id, trigger: 'schedule' },
                log,
                sendOptions: { retryLimit: 2, retryDelay: 120, retryBackoff: true },
            });
            if (outcome === 'dispatched') dispatched += 1;
        }
        log.info('Report fan-out complete', { tenantCount: tenants.length, dispatched });
    });

    await boss.work(REPORT_SCAN, { batchSize: 1 }, async ([job]) => {
        await executor.execute(REPORT_SCAN, job.data, {
            idempotencyKey: job.id,
            timeoutMs: (600 - 60) * 1000,
        });
    });

    // ── Hourly re-observation ─────────────────────────────────────────────────
    //
    // Keeps observedStrategy honest for EVERY managed service, not just the ones the restore
    // scan happens to visit. Without it a healthy service on Spot is never re-read, so a row
    // that drifted stays wrong indefinitely — see handle-observe-scan.ts for the case that
    // proved it.
    await boss.createQueue(OBSERVE_FAN_OUT);
    await boss.updateQueue(OBSERVE_FAN_OUT, {
        name: OBSERVE_FAN_OUT,
        retryLimit: 1,
        expireInSeconds: 300,
        deadLetter: DEAD_LETTER_QUEUE,
    });
    // retryLimit 2 like the report scan, NOT 0 like the restore scan: this pass only calls
    // DescribeServices and writes our own registry. It never calls UpdateService, so a retry
    // cannot bounce a customer's tasks and is free.
    await ensureStatelyScanQueue(boss, OBSERVE_SCAN, log, { expireInSeconds: 600, retryLimit: 2 });
    await boss.schedule(OBSERVE_FAN_OUT, OBSERVE_CRON, {}, { tz: 'UTC' });

    await boss.work(OBSERVE_FAN_OUT, { batchSize: 1 }, async () => {
        const tenants = await getAllTenants();
        let dispatched = 0;
        for (const tenant of tenants) {
            const outcome = await dispatchTenantScan({
                boss,
                scanQueue: OBSERVE_SCAN,
                tenantId: tenant.id,
                jobType: 'spot-guard-observe-cron',
                // Reuses the restore interval: both are hourly, and this guards the same thing
                // (a duplicate enqueue turning into a duplicate pass over the estate).
                minIntervalMs: SPOT_GUARD_CONFIG.restoreMinIntervalMs,
                payload: { tenantId: tenant.id },
                log,
                sendOptions: { retryLimit: 2, retryDelay: 120, retryBackoff: true },
            });
            if (outcome === 'dispatched') dispatched += 1;
        }
        log.info('Observe fan-out complete', { tenantCount: tenants.length, dispatched });
    });

    await boss.work(OBSERVE_SCAN, { batchSize: 1 }, async ([job]) => {
        await executor.execute(OBSERVE_SCAN, job.data, {
            idempotencyKey: job.id,
            timeoutMs: (600 - 60) * 1000,
        });
    });

    // ── In-process: DELIBERATE EXECUTOR BYPASS ────────────────────────────────
    //
    // These call their handlers DIRECTLY rather than through executor.execute(). In prod
    // WORKER_ARCH=horizontal, so executor.execute() is one ECS RunTask per job: ~30-90s
    // wall clock (2s before the first DescribeTasks, then a 2->30s poll backoff) and
    // ~$0.0013/task.
    //
    // One busy 20-service cluster emits ~4,800 ECS Task State Change events/day. Through
    // the executor that is ~4,800 Fargate tasks/day ≈ $6.30/day/account — roughly
    // $9.5k/month at 50 accounts — to perform a few hundred milliseconds of real work per
    // event. It would also throttle RunTask, cap queue throughput at about one event per
    // 45s (a backlog that grows without bound), and, decisively, miss the ~2 minute Spot
    // interruption window on EVERY event.
    //
    // These handlers make at most three AWS calls each. The dividing line is "bounded,
    // sub-second, latency-critical, high-volume" versus "unbounded fan-out over a
    // tenant's estate" — and the restore/report scans sit on the other side of it.
    //
    // ENFORCEMENT: EVENT and BUS_POLICY are intentionally NOT in job-runner.ts HANDLERS.
    // If someone later routes them through the executor, the ephemeral task fails loudly
    // on an unknown job name instead of quietly costing thousands a month.
    await boss.createQueue(EVENT);
    await boss.updateQueue(EVENT, {
        name: EVENT,
        retryLimit: 3,
        retryDelay: 15,
        retryBackoff: true,
        expireInSeconds: 120,
        deadLetter: DEAD_LETTER_QUEUE,
    });

    // Standard (not stately) policy on purpose: events for DIFFERENT services must run
    // concurrently. Per-service serialisation comes from the idempotency guards, not from
    // queue policy. A wide batch keeps a burst — a 50-task service redeploying — draining
    // in one poll instead of fifty.
    await boss.work(EVENT, { batchSize: SPOT_GUARD_CONFIG.eventBatchSize }, async (jobs) => {
        for (const job of jobs) {
            await handleSpotGuardEvent(job.data);
        }
    });

    await boss.createQueue(BUS_POLICY);
    await boss.updateQueue(BUS_POLICY, {
        name: BUS_POLICY,
        retryLimit: 3,
        retryDelay: 30,
        retryBackoff: true,
        expireInSeconds: 120,
        deadLetter: DEAD_LETTER_QUEUE,
    });
    await boss.work(BUS_POLICY, { batchSize: 1 }, async () => {
        await handleBusPolicyReconcile();
    });
    await boss.schedule(BUS_POLICY, BUS_POLICY_CRON, {}, { tz: 'UTC' });

    // Eager reconcile at startup, mirroring the agent-ops sweeper's initial sweep. Never
    // fatal: a bus-policy problem must not stop the worker from booting and processing
    // everything else.
    await handleBusPolicyReconcile().catch((err) =>
        log.error('Initial bus policy reconcile failed — hourly cron will retry', {
            error: err instanceof Error ? err.message : String(err),
        }),
    );

    // Started LAST, once every queue exists, so the first received message has somewhere
    // to go.
    startSpotGuardConsumer(boss);

    log.info('Registered Spot Guard', {
        inProcess: [EVENT, BUS_POLICY],
        viaExecutor: [RESTORE_SCAN, REPORT_SCAN],
        crons: { restore: RESTORE_CRON, busPolicy: BUS_POLICY_CRON, report: REPORT_CRON },
    });
}

/** Enqueue an on-demand restore for one tenant (the UI's "Restore now"). */
export async function enqueueSpotGuardRestore(
    boss: PgBoss,
    tenantId: string,
    serviceIds?: string[],
): Promise<string | null> {
    return boss.send(
        RESTORE_SCAN,
        { tenantId, trigger: 'manual', serviceIds, force: true },
        { singletonKey: `tenant:${tenantId}`, retryLimit: 0 },
    );
}
