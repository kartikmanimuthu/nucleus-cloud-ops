// workers/src/lib/observability.ts
//
// Cross-cutting operational wiring for the workers process:
//   - a single shared dead-letter queue + consumer, so a job that exhausts its
//     retries or expires lands somewhere an operator can see instead of vanishing
//     into the archive (a tenant whose discovery has failed for days is a churn
//     event you would otherwise never notice);
//   - the pg-boss monitor-states listener, which both drives the health heartbeat
//     and emits per-queue depth as structured logs (+ best-effort CloudWatch
//     metrics) so queue backlog is alarmable;
//   - a consecutive-error tripwire on the boss 'error' event that exits the process
//     so ECS restarts a wedged task.

import type PgBoss from 'pg-boss';
import type { Logger } from './logger.js';
import { DEAD_LETTER_QUEUE } from './tenant-fanout.js';
import { heartbeat } from './health.js';

const METRIC_NAMESPACE = 'Nucleus/Workers';

// Lazily-created, reused across calls (avoids a new client + credential resolution
// per metric). Typed loosely so the SDK import stays fully dynamic/best-effort.
let _cwClient: { send: (cmd: unknown) => Promise<unknown> } | null = null;

/** Best-effort CloudWatch metric — never throws, never blocks job flow. */
async function emitMetric(name: string, value: number, dims: Record<string, string>): Promise<void> {
    try {
        const { CloudWatchClient, PutMetricDataCommand } = await import('@aws-sdk/client-cloudwatch');
        if (!_cwClient) _cwClient = new CloudWatchClient({}) as unknown as typeof _cwClient;
        await _cwClient!.send(new PutMetricDataCommand({
            Namespace: METRIC_NAMESPACE,
            MetricData: [{
                MetricName: name,
                Value: value,
                Unit: 'Count',
                Dimensions: Object.entries(dims).map(([Name, Value]) => ({ Name, Value })),
            }],
        }));
    } catch {
        // Missing IAM / offline / SDK error — the structured log line is the durable
        // signal; metrics are a convenience on top.
    }
}

/**
 * Create the shared dead-letter queue and a consumer that records every dead job.
 * All tenant scan queues route exhausted/expired jobs here (see tenant-fanout).
 */
export async function registerDeadLetterQueue(boss: PgBoss, log: Logger): Promise<void> {
    await boss.createQueue(DEAD_LETTER_QUEUE);
    // Keep dead jobs around longer than the global default so they can be inspected.
    await boss.updateQueue(DEAD_LETTER_QUEUE, { name: DEAD_LETTER_QUEUE, expireInSeconds: 3600 });

    await boss.work(DEAD_LETTER_QUEUE, { batchSize: 10 }, async (jobs) => {
        for (const job of jobs) {
            const data = (job.data ?? {}) as { tenantId?: string; type?: string };
            // Structured line: drives a CloudWatch Logs metric filter + alarm with
            // zero extra IAM. metric=dlq.job is the stable key to filter on.
            log.error('DEAD-LETTER job received', {
                metric: 'dlq.job',
                deadLetterJobId: job.id,
                tenantId: data.tenantId ?? 'unknown',
                originalType: data.type ?? 'unknown',
                data: job.data,
            });
            await emitMetric('DeadLetterJobs', 1, { tenant: data.tenantId ?? 'unknown' });
        }
    });

    log.info('Registered dead-letter queue + consumer', { queue: DEAD_LETTER_QUEUE });
}

/**
 * Subscribe to pg-boss monitoring so (a) the health heartbeat advances only while
 * the supervisor loop is genuinely alive, and (b) queue depth is observable.
 * Requires monitorStateIntervalSeconds set in the boss options (it is — see boss.ts).
 */
export function registerMonitoring(boss: PgBoss, log: Logger): void {
    boss.on('monitor-states', (states) => {
        heartbeat();
        // states.queues is a map of queue name -> counts by state.
        for (const [queue, counts] of Object.entries(states.queues ?? {})) {
            const created = counts.created ?? 0;
            const active = counts.active ?? 0;
            // Only log queues with backlog/activity to keep log volume sane.
            if (created > 0 || active > 0) {
                log.info('queue-depth', { metric: 'queue.depth', queue, created, active });
            }
        }
    });

    boss.on('wip', () => heartbeat());
    boss.on('maintenance', () => heartbeat());

    log.info('Registered pg-boss monitoring listeners');
}

/**
 * Wire a consecutive-error tripwire onto the boss 'error' event. Transient errors
 * are logged; a sustained burst (DB gone, supervisor faulted) exits the process so
 * ECS restarts the task rather than leaving it silently degraded.
 */
export function registerErrorTripwire(
    boss: PgBoss,
    log: Logger,
    opts: { threshold: number; windowMs: number },
): void {
    let count = 0;
    let firstAt = 0;

    boss.on('error', (error) => {
        const now = Date.now();
        if (now - firstAt > opts.windowMs) {
            count = 0;
            firstAt = now;
        }
        count++;
        log.error('pg-boss error', { error: String(error), consecutive: count });
        if (count >= opts.threshold) {
            log.error('pg-boss error threshold exceeded — exiting for ECS to restart the task', {
                threshold: opts.threshold,
                windowMs: opts.windowMs,
            });
            // Non-zero so ECS treats it as a crash and reschedules.
            process.exit(1);
        }
    });
}
