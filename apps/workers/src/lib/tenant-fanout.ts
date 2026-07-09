// workers/src/lib/tenant-fanout.ts
//
// Shared building blocks for the per-tenant fan-out pattern that every periodic
// job family in this service uses:
//
//   cron tick → cheap gate loop → one stately, per-tenant job per due tenant
//
// Discovery pioneered this shape; scheduler and right-sizing now share it through
// these helpers so any future job type inherits the same correctness properties by
// construction instead of copy-paste:
//   - a BOUNDED queue (stately: at most one 'created' + one 'active' per tenant),
//     so a cron that keeps firing can never stack a backlog;
//   - an ATOMIC per-tenant claim, so overlapping fan-outs (expiry overlap, rolling
//     deploy, >1 replica) cannot double-dispatch an AWS-mutating scan;
//   - a per-tenant singletonKey, so a duplicate send is a no-op, not a second run.
//
// The dead-letter wiring means a scan that exhausts its retries lands on one
// shared queue an operator can watch, instead of vanishing into the archive.

import type PgBoss from 'pg-boss';
import type { Logger } from './logger.js';
import { tryClaimTenantRun, releaseTenantJobClaim } from '../jobs/scheduler/services/pg-service.js';

/** Shared dead-letter queue name — see registerDeadLetterQueue in index.ts. */
export const DEAD_LETTER_QUEUE = 'dead-letter';

export interface StatelyQueueOptions {
    /** Caps handler runtime AND how long an orphaned 'active' job lingers. */
    expireInSeconds: number;
    /** Per-job retry attempts after the first failure (default 0 = discard). */
    retryLimit?: number;
    /** Route exhausted/expired jobs here for alerting. Defaults to DEAD_LETTER_QUEUE. */
    deadLetter?: string;
}

/**
 * Idempotently create/repair a stately per-tenant scan queue, including the
 * one-time migration off the legacy unbounded 'standard' policy (purges the
 * stacked backlog, then flips policy). Safe to call on every worker start.
 */
export async function ensureStatelyScanQueue(
    boss: PgBoss,
    queueName: string,
    log: Logger,
    opts: StatelyQueueOptions,
): Promise<void> {
    const deadLetter = opts.deadLetter ?? DEAD_LETTER_QUEUE;
    const existing = await boss.getQueue(queueName);
    if (!existing) {
        await boss.createQueue(queueName, {
            name: queueName,
            policy: 'stately',
            retryLimit: opts.retryLimit ?? 0,
            expireInSeconds: opts.expireInSeconds,
            deadLetter,
        });
    } else if (existing.policy !== 'stately') {
        // Migrate off the old unbounded 'standard' queue: purge everything not yet
        // completed so it stops draining, then flip the policy. Idempotent.
        log.info('Migrating queue to stately policy', { queueName, oldPolicy: existing.policy });
        const db = boss.getDb();
        await db.executeSql(`DELETE FROM pgboss.job WHERE name = $1 AND state NOT IN ('completed')`, [queueName]);
        await db.executeSql(`UPDATE pgboss.queue SET policy = 'stately', updated_on = now() WHERE name = $1`, [queueName]);
    }
    // createQueue opts are ON CONFLICT DO NOTHING, so enforce on the existing queue too.
    await boss.updateQueue(queueName, {
        name: queueName,
        retryLimit: opts.retryLimit ?? 0,
        expireInSeconds: opts.expireInSeconds,
        deadLetter,
    });
}

export type DispatchOutcome = 'dispatched' | 'skipped-interval' | 'skipped-duplicate' | 'failed';

export interface DispatchTenantScanArgs {
    boss: PgBoss;
    /** Queue the per-tenant scan job is sent to (the stately scan queue). */
    scanQueue: string;
    tenantId: string;
    /** tenant_configs configKey used for atomic interval gating. */
    jobType: string;
    /** Minimum spacing between runs for this tenant, in ms. */
    minIntervalMs: number;
    payload: unknown;
    log: Logger;
    /** Extra pg-boss send options (retryLimit, retryDelay, …). singletonKey is set here. */
    sendOptions?: Parameters<PgBoss['send']>[2];
    /** singletonKey; defaults to `tenant:<tenantId>`. */
    singletonKey?: string;
}

/**
 * Gate one tenant atomically, then enqueue its per-tenant scan job. Returns an
 * outcome the caller can log/count. Never throws — a single tenant's failure must
 * not abort the fan-out loop or crash the worker.
 */
export async function dispatchTenantScan(args: DispatchTenantScanArgs): Promise<DispatchOutcome> {
    const { boss, scanQueue, tenantId, jobType, minIntervalMs, payload, log } = args;
    const singletonKey = args.singletonKey ?? `tenant:${tenantId}`;

    // Atomic claim — only the winner proceeds to dispatch.
    if (!(await tryClaimTenantRun(tenantId, jobType, minIntervalMs))) {
        return 'skipped-interval';
    }

    try {
        const jobId = await boss.send(scanQueue, payload as object, {
            singletonKey,
            ...args.sendOptions,
        });
        if (jobId === null) {
            // A scan for this tenant is already queued/active. We advanced the claim
            // above, which is correct: the in-flight scan satisfies this interval.
            log.warn('Scan already queued/active — skipping', { tenantId, scanQueue });
            return 'skipped-duplicate';
        }
        log.debug('Tenant scan enqueued', { tenantId, scanQueue, jobId });
        return 'dispatched';
    } catch (err) {
        // Dispatch failed after we claimed — release the claim so the next tick
        // retries this tenant promptly instead of waiting a full interval.
        await releaseTenantJobClaim(tenantId, jobType, minIntervalMs);
        log.error('Tenant scan dispatch failed — claim released for retry', {
            tenantId,
            scanQueue,
            error: err instanceof Error ? err.message : String(err),
        });
        return 'failed';
    }
}
