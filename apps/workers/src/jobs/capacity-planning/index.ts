// workers/src/jobs/capacity-planning/index.ts
//
// Capacity Planning worker orchestrator (SA-004) — the second STX compliance
// report after Scaling Events. Clones the right-sizing/scaling-audit fan-out
// structure: daily fan-out → one stately scan job per tenant. Per workload
// account: list ECS services + ASGs from inventory → resolve installed
// capacity (ECS: DescribeTaskDefinition, deduped) → hourly CPU/Mem, written
// into capacity_utilization_samples.
//
// Gated on SCALING_AUDIT_ENABLED — this is presented to the user as one
// module ("Scale Sentinel"), so it shares Scale Sentinel's single on/off
// switch at both the stack level (env) and the account level
// (Account.scalingAuditEnabled, via getScalingAuditEligibleAccounts).
import type PgBoss from 'pg-boss';
import { createLogger } from '../../lib/logger.js';
import type { JobExecutor } from '../../executor/index.js';
import { getAllTenants } from '../discovery/services/account-service.js';
import { assumeRole } from '../discovery/services/sts-service.js';
import { getScalingAuditEligibleAccounts } from '../scaling-audit/services/db-writer.js';
import { ensureStatelyScanQueue, dispatchTenantScan, DEAD_LETTER_QUEUE } from '../../lib/tenant-fanout.js';
import { fetchHourlyUtilization } from '../../lib/cloudwatch-client.js';
import { fetchInstalledCapacity } from './services/ecs-capacity-client.js';
import {
    getEcsServicesToScan,
    getAsgsToScan,
    getLastBucket,
    upsertSamples,
    createRun,
    finishRun,
    hasActiveRun,
} from './services/db-writer.js';
import { CAPACITY_PLANNING_CONFIG } from './config.js';
import { env } from '../../env.js';
import type { CapacityPlanningScanJob, CapacitySample, ResourceToScan } from './types.js';

const log = createLogger('capacity-planning');
const FAN_OUT = 'capacity-planning-fan-out';
const SCAN = 'capacity-planning-scan';

function resourceKey(r: ResourceToScan): string {
    return `${r.resourceType}|${r.resourceId}`;
}

/** The current (still-incomplete) hour is excluded — its Average/Max would be
 *  computed over a partial hour and look like an anomalous mid-poll dip. */
function currentHourBoundary(now: Date): Date {
    return new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
}

/** Earliest bucketStartUtc across a set of resources' own last-written
 *  bucket (with the overlap margin), falling back to the full backfill
 *  window for a never-before-seen resource. */
function widestWindowStart(lastBuckets: Iterable<Date | null>, backfillFloor: Date, endTime: Date): Date {
    let windowStart = endTime;
    for (const lb of lastBuckets) {
        const candidate = lb ? new Date(lb.getTime() - CAPACITY_PLANNING_CONFIG.watermarkOverlapHours * 3_600_000) : backfillFloor;
        if (candidate < windowStart) windowStart = candidate;
    }
    return windowStart;
}

/** Run capacity-planning for one account+region. Returns samples written. */
async function scanAccountRegion(
    tenantId: string, accountId: string, region: string,
    assumed: Awaited<ReturnType<typeof assumeRole>>, runId: string
): Promise<{ resourcesScanned: number; samplesWritten: number }> {
    const [ecsResources, asgResources] = await Promise.all([
        getEcsServicesToScan(tenantId, accountId),
        getAsgsToScan(tenantId, accountId),
    ]);
    const resources = [...ecsResources, ...asgResources];
    if (!resources.length) return { resourcesScanned: 0, samplesWritten: 0 };

    const taskDefArns = ecsResources.map((r) => r.taskDefinitionArn).filter((a): a is string => !!a);
    const installedCapacity = await fetchInstalledCapacity(taskDefArns, assumed, region);

    const now = new Date();
    const endTime = currentHourBoundary(now);
    const backfillFloor = new Date(now.getTime() - CAPACITY_PLANNING_CONFIG.backfillDays * 86_400_000);

    const lastBuckets = new Map<string, Date | null>();
    await Promise.all(
        resources.map(async (r) => lastBuckets.set(resourceKey(r), await getLastBucket(tenantId, r.resourceType, r.resourceId)))
    );

    // One batched CloudWatch call per account+region: the query window is the
    // widest any single resource needs (a never-before-seen resource pulls the
    // full backfill), but re-fetching a few already-known hours for resources
    // that are more caught-up is harmless — upsertSamples is DO UPDATE.
    const windowStart = widestWindowStart(lastBuckets.values(), backfillFloor, endTime);
    if (windowStart >= endTime) return { resourcesScanned: resources.length, samplesWritten: 0 };

    const buckets = await fetchHourlyUtilization(
        resources.map((r) => ({ key: resourceKey(r), resourceType: r.resourceType, clusterName: r.clusterName, serviceName: r.serviceName, asgName: r.asgName })),
        assumed, region, windowStart, endTime
    );

    const samples: CapacitySample[] = [];
    for (const r of resources) {
        const key = resourceKey(r);
        const lastBucket = lastBuckets.get(key) ?? null;
        const installed = r.taskDefinitionArn ? installedCapacity.get(r.taskDefinitionArn) : undefined;
        for (const b of buckets.get(key) ?? []) {
            if (lastBucket && b.bucketStartUtc <= lastBucket) continue; // already have it
            samples.push({
                tenantId, accountId, region,
                resourceType: r.resourceType, resourceId: r.resourceId,
                clusterName: r.clusterName, serviceName: r.serviceName, asgName: r.asgName,
                bucketStartUtc: b.bucketStartUtc,
                cpuAvg: b.cpuAvg, cpuMax: b.cpuMax, memAvg: b.memAvg, memMax: b.memMax,
                installedVcpu: installed?.vcpu, installedMemGiB: installed?.memGiB,
            });
        }
    }

    const written = await upsertSamples(samples, runId);
    return { resourcesScanned: resources.length, samplesWritten: written };
}

/** Run the full capacity-planning poll for one tenant. */
export async function handleScan(jobData: unknown): Promise<void> {
    const { tenantId, trigger, runId: providedRunId } = jobData as CapacityPlanningScanJob;
    const runId = providedRunId ?? (await createRun(tenantId, trigger));
    const errors: Array<{ accountId?: string; region?: string; error: string }> = [];
    let accountsScanned = 0;
    let resourcesScanned = 0;
    let samplesWritten = 0;

    try {
        const accounts = await getScalingAuditEligibleAccounts(tenantId);

        for (const account of accounts) {
            if (!account.roleArn) {
                errors.push({ accountId: account.accountId, error: 'No roleArn configured' });
                continue;
            }
            accountsScanned += 1;
            for (const region of account.regions ?? []) {
                try {
                    const assumed = await assumeRole(account.roleArn, account.accountId, region, account.externalId, `NucleusCapacityPlanning-${account.accountId}-${region}`);
                    const { resourcesScanned: rc, samplesWritten: sw } = await scanAccountRegion(tenantId, account.accountId, region, assumed, runId);
                    resourcesScanned += rc;
                    samplesWritten += sw;
                } catch (regionErr) {
                    errors.push({ accountId: account.accountId, region, error: String(regionErr) });
                }
            }
        }

        await finishRun(runId, tenantId, { status: 'completed', accountsScanned, resourcesScanned, samplesWritten, errors });
        log.info('Scan complete', { tenantId, runId, accountsScanned, resourcesScanned, samplesWritten, errors: errors.length });
    } catch (err) {
        log.error('Scan failed', { tenantId, runId, error: String(err) });
        await finishRun(runId, tenantId, { status: 'failed', accountsScanned, resourcesScanned, samplesWritten, errors: [...errors, { error: String(err) }] });
        throw err; // let pg-boss retry
    }
}

export async function register(boss: PgBoss, executor: JobExecutor): Promise<void> {
    if (env.SCALING_AUDIT_ENABLED !== 'true') {
        log.info('SCALING_AUDIT_ENABLED is not "true" — Capacity Planning not registered');
        return;
    }

    executor.registerHandler?.('capacity-planning-scan', handleScan);

    await boss.createQueue(FAN_OUT);
    await boss.updateQueue(FAN_OUT, { name: FAN_OUT, retryLimit: 1, expireInSeconds: 300, deadLetter: DEAD_LETTER_QUEUE });

    // Read-only CloudWatch polling — retries are safe.
    await ensureStatelyScanQueue(boss, SCAN, log, { expireInSeconds: 3600, retryLimit: 2 });

    await boss.schedule(FAN_OUT, CAPACITY_PLANNING_CONFIG.cron, {}, { tz: 'UTC' });

    await boss.work(FAN_OUT, { batchSize: 1 }, async () => {
        const tenants = await getAllTenants();
        let dispatched = 0;
        for (const tenant of tenants) {
            const outcome = await dispatchTenantScan({
                boss,
                scanQueue: SCAN,
                tenantId: tenant.id,
                jobType: 'capacity-planning-cron',
                minIntervalMs: 20 * 60 * 60 * 1000, // daily cadence, no per-tenant config — same as scaling-audit
                payload: { tenantId: tenant.id, trigger: 'schedule' } satisfies CapacityPlanningScanJob,
                log,
                sendOptions: { retryLimit: 2, retryDelay: 60, retryBackoff: true },
            });
            if (outcome === 'dispatched') dispatched++;
        }
        log.info('Capacity-planning fan-out complete', { tenantCount: tenants.length, dispatched });
    });

    await boss.work<CapacityPlanningScanJob>(SCAN, { batchSize: 1 }, async ([job]) => {
        await executor.execute('capacity-planning-scan', job.data, { idempotencyKey: job.id, timeoutMs: (3600 - 60) * 1000 });
    });

    log.info('Registered queues', { queues: [FAN_OUT, SCAN], cron: CAPACITY_PLANNING_CONFIG.cron });
}

/** Enqueue an on-demand scan for a tenant. Returns the pg-boss job id, or null
 *  if a scan is already queued/active (per-tenant singleton). */
export async function enqueueCapacityPlanningScan(boss: PgBoss, tenantId: string): Promise<string | null> {
    if (await hasActiveRun(tenantId)) return null;
    return boss.send(
        SCAN,
        { tenantId, trigger: 'manual' } satisfies CapacityPlanningScanJob,
        { singletonKey: `tenant:${tenantId}`, retryLimit: 2, retryDelay: 60, retryBackoff: true }
    );
}
