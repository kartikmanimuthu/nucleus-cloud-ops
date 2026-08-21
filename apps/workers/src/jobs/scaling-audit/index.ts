// workers/src/jobs/scaling-audit/index.ts
//
// Scaling Audit worker orchestrator (SA-001). Clones the right-sizing fan-out
// structure exactly: daily fan-out → one stately scan job per tenant. Each scan:
// per account → per region → (policy snapshot) + (per scope: ASG, ECS, RDS, MSK,
// ElastiCache, DocDB) poll AWS's scaling-activity/CloudTrail sources from the
// tenant's watermark forward, normalize + classify, insert (idempotent), advance
// the watermark, record coverage — plus a best-effort Network Pulse (DX/VPN)
// bandwidth collection step alongside it.
//
// Gated on SCALING_AUDIT_ENABLED so the image ships everywhere while the
// behaviour activates only where the tenant has opted in — same pattern as
// SPOT_GUARD_ENABLED (jobs/spot-guard/index.ts).
import type PgBoss from 'pg-boss';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { createLogger } from '../../lib/logger.js';
import type { JobExecutor } from '../../executor/index.js';
import { getAllTenants } from '../discovery/services/account-service.js';
import { assumeRole } from '../discovery/services/sts-service.js';
import { writeAuditLog } from '../discovery/services/audit-service.js';
import { ensureStatelyScanQueue, dispatchTenantScan, DEAD_LETTER_QUEUE } from '../../lib/tenant-fanout.js';
import { env } from '../../env.js';
import { SCALING_AUDIT_CONFIG } from './config.js';
import { fetchAsgActivities } from './services/asg-client.js';
import { fetchEcsScalingActivities } from './services/app-autoscaling-client.js';
import { fetchCloudTrailCapacityChanges } from './services/cloudtrail-client.js';
import { fetchRdsStorageAutoscalingEvents } from './services/rds-events-client.js';
import { fetchRdsCloudTrailCapacityChanges } from './services/rds-cloudtrail-client.js';
import { fetchDocDbEvents } from './services/docdb-events-client.js';
import { fetchDocDbCloudTrailCapacityChanges } from './services/docdb-cloudtrail-client.js';
import { fetchMskOperations } from './services/msk-operations-client.js';
import { fetchMskCloudTrailCapacityChanges } from './services/msk-cloudtrail-client.js';
import { fetchElastiCacheCloudTrailCapacityChanges } from './services/elasticache-cloudtrail-client.js';
import { fetchDirectConnectConnections, fetchVpnTunnels } from './services/network-client.js';
import { fetchNetworkUtilization, type NetworkResourceRef } from './services/network-cloudwatch-client.js';
import { fetchAsgPolicySnapshots, fetchEcsPolicySnapshots, upsertPolicySnapshots } from './services/policy-snapshot.js';
import { normalizeActivity } from './services/normalize.js';
import { computeWatermarkAdvance, isTerminalStatus } from './services/watermark.js';
import { sealPendingDays } from './services/daily-seal.js';
import { fetchScalingEnrichment } from '../../lib/cloudwatch-client.js';
import {
    createCoverageRow,
    createRun,
    finishRun,
    getInventoryResourceIds,
    getScalingAuditEligibleAccounts,
    getWatermark,
    hasActiveRun,
    hasCompletedRun,
    insertEvents,
    updateCoverageRow,
    upsertWatermark,
    upsertNetworkLinkSamples,
} from './services/db-writer.js';
import type { AssumedCredentials } from '../discovery/types.js';
import type { NormalizedScalingEvent, PollOutcome, PolledSource, RunTrigger, ScalingScope } from './types.js';

dayjs.extend(utc);
dayjs.extend(timezone);

const log = createLogger('scaling-audit');
const FAN_OUT = 'scaling-audit-fan-out';
const SCAN = 'scaling-audit-scan';
const SCOPES: ScalingScope[] = ['asg', 'ecs', 'rds', 'msk', 'elasticache', 'docdb'];
// ecs + asg share ONE CloudTrail sweep (fetchCloudTrailCapacityChanges filters
// one LookupEvents pass by scope) — kept as its own pair since that dual-scope
// split only makes sense for those two. Every other scope has its OWN
// single-scope CloudTrail fetcher (no shared sweep).
const ECS_ASG_SCOPES: ('ecs' | 'asg')[] = ['ecs', 'asg'];
const SINGLE_SCOPE_CLOUDTRAIL_SCOPES: ('rds' | 'docdb' | 'msk' | 'elasticache')[] = ['rds', 'docdb', 'msk', 'elasticache'];
// elasticache has no unified scaling-activity API to poll at all (see
// elasticache-cloudtrail-client.ts's header) — CloudTrail is its sole source.
const AWS_API_SCOPES: Exclude<ScalingScope, 'elasticache'>[] = ['asg', 'ecs', 'rds', 'docdb', 'msk'];

export interface ScalingAuditScanJob {
    tenantId: string;
    trigger: 'schedule' | 'manual';
    runId?: string;
}

interface ScanTotals {
    accountsScanned: number;
    scopesPolled: number;
    eventsSeen: number;
    eventsCaptured: number;
    policySnapshots: number;
    gapsDetected: number;
    apiCallCount: number;
    errors: Array<{ accountId?: string; region?: string; scope?: string; error: string }>;
}

/** Dispatch to the right aws_api fetcher for one of AWS_API_SCOPES. Elasticache
 *  has no aws_api source at all (see AWS_API_SCOPES's doc comment) and is never
 *  passed here — callers filter it out before calling. */
function pollScope(
    scope: Exclude<ScalingScope, 'elasticache'>,
    assumed: AssumedCredentials,
    region: string,
    sinceAt: Date | null,
    now: Date
): Promise<PollOutcome> {
    switch (scope) {
        case 'asg':
            return fetchAsgActivities(assumed, region, sinceAt);
        case 'ecs':
            return fetchEcsScalingActivities(assumed, region, sinceAt);
        case 'rds':
            return fetchRdsStorageAutoscalingEvents(assumed, region, sinceAt);
        case 'docdb':
            return fetchDocDbEvents(assumed, region, sinceAt, now);
        case 'msk':
            return fetchMskOperations(assumed, region, sinceAt);
    }
}

/** Dispatch to the right single-scope CloudTrail fetcher for one of
 *  SINGLE_SCOPE_CLOUDTRAIL_SCOPES — everything except the ecs/asg pair, which
 *  shares one sweep via fetchCloudTrailCapacityChanges instead (see
 *  pollAndPersistCloudTrail). */
function pollSingleScopeCloudTrail(
    scope: 'rds' | 'docdb' | 'msk' | 'elasticache',
    assumed: AssumedCredentials,
    region: string,
    sinceAt: Date | null,
    now: Date,
    platformRoleArn?: string
): Promise<PollOutcome & { retentionClamped: boolean; platformSkipped: number }> {
    switch (scope) {
        case 'rds':
            return fetchRdsCloudTrailCapacityChanges(assumed, region, sinceAt, now, platformRoleArn);
        case 'docdb':
            return fetchDocDbCloudTrailCapacityChanges(assumed, region, sinceAt, now, platformRoleArn);
        case 'msk':
            return fetchMskCloudTrailCapacityChanges(assumed, region, sinceAt, now, platformRoleArn);
        case 'elasticache':
            return fetchElastiCacheCloudTrailCapacityChanges(assumed, region, sinceAt, now, platformRoleArn);
    }
}

/**
 * Terminal outcomes where the activity was recorded but capacity never
 * actually moved — same set the compliance report's "capacity changes only"
 * filter excludes (apps/web-ui's NON_EFFECTIVE_STATUS_CODES). A 'not_scaled'
 * activity (AWS evaluated the policy and chose not to act) belongs in this
 * same "nothing to backfill" bucket even though it isn't a statusCode.
 * Guards desiredAfter backfill specifically: filling in a plausible-looking
 * "after" value for an action that never happened would be actively wrong,
 * not just absent.
 */
const NON_EFFECTIVE_STATUS_CODES = new Set(['Failed', 'Cancelled', 'Unfulfilled']);

/**
 * Best-effort CloudWatch enrichment (SA-003), mutating `events` in place —
 * fills desiredBefore/desiredAfter from the DesiredTaskCount metric when the
 * activity's own Cause/Description didn't carry them (true for every
 * CloudTrail row and most ECS aws_api rows — desiredAfter in particular is
 * absent whenever a scheduled action only touches min/max bounds, e.g.
 * "Setting min capacity to 4 and max capacity to 10" never says what desired
 * count that raised the floor to), and always adds peak CPU/Memory in the 15
 * minutes before the event. Never throws: a CloudWatch outage must not block
 * event capture, which is why this sits right before insertEvents() rather
 * than earlier in the flow.
 */
async function enrichBeforeInsert(
    events: NormalizedScalingEvent[], assumed: Parameters<typeof fetchAsgActivities>[0], region: string
): Promise<void> {
    if (!events.length) return;
    try {
        const results = await fetchScalingEnrichment(
            // This job's own pipeline only ever produces ecs/asg rows (ASG/App
            // Auto Scaling APIs + CloudTrail filtered to ECS/ASG event names) —
            // the cast reflects that, not a relaxation of fetchScalingEnrichment's
            // own ecs/asg-only CloudWatch lookup.
            events.map((e) => ({
                scope: e.scope as 'asg' | 'ecs',
                clusterName: e.clusterName,
                serviceName: e.serviceName,
                asgName: e.asgName,
                startedAt: e.startedAt,
                endedAt: e.endedAt,
                needsDesiredBefore: e.scope === 'ecs' && e.desiredBefore == null,
                needsDesiredAfter:
                    e.scope === 'ecs' &&
                    e.desiredAfter == null &&
                    e.scalingType !== 'not_scaled' &&
                    !NON_EFFECTIVE_STATUS_CODES.has(e.statusCode ?? ''),
            })),
            assumed,
            region
        );
        results.forEach((r, idx) => {
            const e = events[idx];
            if (r.desiredBefore != null && e.desiredBefore == null) {
                e.desiredBefore = r.desiredBefore;
                e.desiredBeforeSource = 'cloudwatch';
            }
            if (r.desiredAfter != null && e.desiredAfter == null) e.desiredAfter = r.desiredAfter;
            if (r.peakCpuBeforeScale != null) e.peakCpuBeforeScale = r.peakCpuBeforeScale;
            if (r.peakMemoryBeforeScale != null) e.peakMemoryBeforeScale = r.peakMemoryBeforeScale;
        });
    } catch (err) {
        log.warn('CloudWatch enrichment failed — proceeding without it', { error: String(err) });
    }
}

/** Run the full scaling-audit poll for one tenant. */
export async function handleScan(jobData: unknown): Promise<void> {
    const { tenantId, trigger: requestedTrigger, runId: providedRunId } = jobData as ScalingAuditScanJob;
    const trigger: RunTrigger = requestedTrigger === 'manual' ? 'manual' : (await hasCompletedRun(tenantId)) ? 'schedule' : 'backfill';
    const runId = providedRunId ?? (await createRun(tenantId, trigger));
    const now = new Date();

    const totals: ScanTotals = {
        accountsScanned: 0, scopesPolled: 0, eventsSeen: 0, eventsCaptured: 0,
        policySnapshots: 0, gapsDetected: 0, apiCallCount: 0, errors: [],
    };

    try {
        // Only accounts that opted in via Account.scalingAuditEnabled — the stack-level
        // SCALING_AUDIT_ENABLED flag above just gates whether this job runs at all.
        const accounts = await getScalingAuditEligibleAccounts(tenantId);

        for (const account of accounts) {
            if (!account.roleArn) {
                totals.errors.push({ accountId: account.accountId, error: 'No roleArn for account' });
                continue;
            }
            totals.accountsScanned += 1;

            for (const region of account.regions) {
                let assumed;
                try {
                    assumed = await assumeRole(account.roleArn, account.accountId, region, account.externalId, `NucleusScalingAudit-${account.accountId}-${region}`);
                } catch (err) {
                    totals.errors.push({ accountId: account.accountId, region, error: `AssumeRole failed: ${String(err)}` });
                    // Only scopes with an aws_api source at all — elasticache has none
                    // (see AWS_API_SCOPES) and would otherwise get a permanently-failed
                    // coverage row for a source it can never actually poll.
                    for (const scope of AWS_API_SCOPES) {
                        await recordFailedScope(tenantId, account.accountId, region, scope, 'aws_api', runId, now, 'sts_assume_role_denied', String(err), totals);
                    }
                    // CloudTrail is a separate source and needs its own failed
                    // coverage row, or its window would look unattempted rather
                    // than failed. Every scope has a cloudtrail source (elasticache's
                    // is its ONLY source), so this covers all of SCOPES.
                    for (const scope of SCOPES) {
                        await recordFailedScope(tenantId, account.accountId, region, scope, 'cloudtrail', runId, now, 'sts_assume_role_denied', String(err), totals);
                    }
                    continue;
                }

                totals.policySnapshots += await runPolicySnapshot(tenantId, account.accountId, region, assumed);

                // Best-effort DX/VPN bandwidth collection — never lets a discovery or
                // CloudWatch failure abort the scope polling below for this region.
                await collectNetworkLinkSamples(tenantId, account.accountId, region, assumed, now);

                for (const scope of SCOPES) {
                    if (scope === 'elasticache') continue; // no aws_api source for this scope — cloudtrail only, below
                    totals.scopesPolled += 1;
                    await pollAndPersistScope(tenantId, account.accountId, region, scope, assumed, runId, now, totals);
                }

                // Out-of-band changes the activity APIs structurally cannot see.
                // One poll per region covers both ecs+asg, so it sits outside the
                // per-scope loop; it writes its own per-scope coverage rows.
                totals.scopesPolled += ECS_ASG_SCOPES.length;
                await pollAndPersistCloudTrail(tenantId, account.accountId, region, assumed, runId, now, totals, account.roleArn);

                // Every other scope has its OWN single-scope CloudTrail source
                // (no shared sweep — see SINGLE_SCOPE_CLOUDTRAIL_SCOPES).
                for (const scope of SINGLE_SCOPE_CLOUDTRAIL_SCOPES) {
                    totals.scopesPolled += 1;
                    await pollAndPersistSingleScopeCloudTrail(tenantId, account.accountId, region, scope, assumed, runId, now, totals, account.roleArn);
                }
            }
        }

        const status = totals.errors.length === 0 ? 'completed' : totals.eventsCaptured > 0 || totals.accountsScanned > totals.errors.length ? 'partial' : 'failed';
        await finishRun(runId, tenantId, { ...totals, status });
        await writeAuditLog({
            tenantId,
            eventType: 'scaling_audit.run.completed',
            action: 'Scaling audit scan completed',
            resourceId: runId,
            // audit_logs CHECK constraints: status IN (success|error|warning|info|pending),
            // severity IN (low|medium|high|critical|info) — 'partial'/'warning'-as-severity
            // are not valid values for either column.
            status: totals.errors.length ? 'warning' : 'success',
            severity: totals.gapsDetected > 0 ? 'high' : 'info',
            details: `Captured ${totals.eventsCaptured}/${totals.eventsSeen} scaling events across ${totals.accountsScanned} account(s); ${totals.gapsDetected} gap(s) detected.`,
            metadata: { runId, trigger, ...totals },
        });
        log.info('Scan complete', { tenantId, runId, ...totals });
    } catch (err) {
        log.error('Scan failed', { tenantId, runId, error: String(err) });
        await finishRun(runId, tenantId, { ...totals, status: 'failed', errors: [...totals.errors, { error: String(err) }] });
        throw err; // let pg-boss retry
    }
}

async function recordFailedScope(
    tenantId: string, accountId: string, region: string, scope: ScalingScope, source: PolledSource,
    runId: string, now: Date, reason: string, message: string, totals: ScanTotals
): Promise<void> {
    const watermark = await getWatermark(tenantId, accountId, region, scope, source);
    const windowStart = watermark.lastActivityAt ?? new Date(now.getTime() - SCALING_AUDIT_CONFIG.awsRetentionDays * 86400_000);
    const coverageId = await createCoverageRow({ tenantId, accountId, region, scope, source, windowStart, windowEnd: now, runId });
    await updateCoverageRow(coverageId, { status: 'failed', reason, activityCount: 0, apiCallCount: 0, pagesFetched: 0, truncated: false });
    await upsertWatermark(tenantId, accountId, region, scope, source, { lastRunId: runId, success: false });
    totals.errors.push({ accountId, region, scope, error: `${source}/${reason}: ${message}` });
}

async function runPolicySnapshot(tenantId: string, accountId: string, region: string, assumed: Parameters<typeof fetchAsgActivities>[0]): Promise<number> {
    try {
        const [asgSnapshots, ecsSnapshots] = await Promise.all([
            fetchAsgPolicySnapshots(assumed, region),
            fetchEcsPolicySnapshots(assumed, region),
        ]);
        const written = await Promise.all([
            upsertPolicySnapshots(tenantId, accountId, region, 'asg', asgSnapshots),
            upsertPolicySnapshots(tenantId, accountId, region, 'ecs', ecsSnapshots),
        ]);
        return written[0] + written[1];
    } catch (err) {
        // Policy snapshots are a should-have enrichment, not the primary compliance
        // record — a failure here must never abort the scaling-event capture below.
        log.warn('Policy snapshot failed', { tenantId, accountId, region, error: String(err) });
        return 0;
    }
}

// scope excludes 'elasticache' — the only caller loop skips it before calling
// (see AWS_API_SCOPES: elasticache has no aws_api source to poll at all).
async function pollAndPersistScope(
    tenantId: string, accountId: string, region: string, scope: Exclude<ScalingScope, 'elasticache'>,
    assumed: Parameters<typeof fetchAsgActivities>[0], runId: string, now: Date, totals: ScanTotals
): Promise<void> {
    const watermark = await getWatermark(tenantId, accountId, region, scope, 'aws_api');
    const sinceAt = watermark.lastActivityAt
        ? new Date(watermark.lastActivityAt.getTime() - SCALING_AUDIT_CONFIG.watermarkOverlapMinutes * 60_000)
        : null;
    const windowStart = sinceAt ?? new Date(now.getTime() - SCALING_AUDIT_CONFIG.awsRetentionDays * 86400_000);

    const coverageId = await createCoverageRow({ tenantId, accountId, region, scope, source: 'aws_api', windowStart, windowEnd: now, runId });
    const result = await pollScope(scope, assumed, region, sinceAt, now);
    totals.apiCallCount += result.apiCallCount;

    if (result.error) {
        await updateCoverageRow(coverageId, {
            status: 'failed', reason: result.error.reason, activityCount: 0,
            apiCallCount: result.apiCallCount, pagesFetched: result.pagesFetched, truncated: result.truncated,
        });
        await upsertWatermark(tenantId, accountId, region, scope, 'aws_api', { lastRunId: runId, success: false });
        totals.errors.push({ accountId, region, scope, error: `${result.error.reason}: ${result.error.message}` });
        return;
    }

    // Inventory-match lookup only covers ecs/asg resource types (see
    // getInventoryResourceIds's doc comment) — RDS/MSK/DocDB live under
    // different inventory resource types it was never built to match, so
    // inventoryMatched stays false for them rather than querying a table that
    // cannot answer the question.
    const inventoryIds = scope === 'asg' || scope === 'ecs' ? await getInventoryResourceIds(tenantId, accountId, scope) : new Set<string>();

    // Persist ONLY activities AWS has finished with. A row captured mid-flight
    // would keep its non-terminal statusCode forever: scaling_events is
    // append-only and insertEvents uses ON CONFLICT DO NOTHING, so a later poll
    // re-reading the completed activity cannot correct the stored status — the
    // compliance record would permanently claim 'InProgress' for something that
    // has since succeeded or failed.
    //
    // Deferring is safe precisely because computeWatermarkAdvance() below holds
    // the mark at the oldest in-flight activity, guaranteeing a later poll
    // re-reads it. Both sides share isTerminalStatus() so they cannot disagree —
    // a mismatch would let the watermark advance past a deferred activity and
    // drop it silently.
    const terminalEvents = result.events.filter((e) => isTerminalStatus(e.statusCode));
    const deferredCount = result.events.length - terminalEvents.length;

    const normalized = terminalEvents.map((raw) =>
        normalizeActivity(raw, { tenantId, accountId, region, scope, source: 'aws_api', inventoryResourceIds: inventoryIds })
    );
    totals.eventsSeen += result.events.length;
    // CloudWatch enrichment (DesiredTaskCount backfill, peak CPU/Mem) is
    // ecs/asg-specific by construction — those metrics don't exist for RDS
    // storage size, MSK broker count, etc. — so it's skipped for every other
    // scope rather than calling it with meaningless clusterName/serviceName/
    // asgName fields.
    if (scope === 'asg' || scope === 'ecs') await enrichBeforeInsert(normalized, assumed, region);
    const inserted = await insertEvents(normalized, runId);
    totals.eventsCaptured += inserted;
    if (deferredCount > 0) {
        // Not an error: these are picked up on a later poll once AWS finalises
        // them. Logged so "seen > captured" is attributable to in-flight
        // deferral rather than only to idempotent dedup hits.
        log.info('Deferred in-flight activities until terminal', { tenantId, accountId, region, scope, deferredCount });
    }

    // Never advance the watermark past a non-terminal activity — hold at the
    // oldest in-flight StartTime instead of the newest seen (see watermark.ts).
    const nextMark = computeWatermarkAdvance(
        result.events,
        { at: watermark.lastActivityAt, id: watermark.lastActivityId },
        result.newestActivitySeenAt
    );

    // Gap: the poll couldn't reach far enough back before hitting AWS's ~6-week
    // retention ceiling. Conservative threshold (38d) vs the ~42d real ceiling.
    const staleForTooLong = !!watermark.lastActivityAt && now.getTime() - watermark.lastActivityAt.getTime() > SCALING_AUDIT_CONFIG.awsRetentionDays * 86400_000;
    if (staleForTooLong) totals.gapsDetected += 1;

    await upsertWatermark(tenantId, accountId, region, scope, 'aws_api', {
        lastActivityAt: nextMark.at,
        lastActivityId: nextMark.id,
        lastRunId: runId,
        success: true,
        gap: staleForTooLong ? { fromAt: watermark.lastActivityAt, toAt: result.oldestActivitySeenAt, reason: 'source_retention_exceeded' } : null,
    });

    await updateCoverageRow(coverageId, {
        status: result.truncated ? 'partial' : 'covered',
        reason: result.truncated ? 'max_pages_exceeded' : undefined,
        activityCount: result.events.length,
        apiCallCount: result.apiCallCount,
        pagesFetched: result.pagesFetched,
        truncated: result.truncated,
        oldestActivitySeenAt: result.oldestActivitySeenAt,
        newestActivitySeenAt: result.newestActivitySeenAt,
    });
}

/**
 * Capture out-of-band capacity changes from CloudTrail for one account/region.
 *
 * One API sweep covers both scopes (LookupEvents is filtered by event name, not
 * by resource type), so this runs once per region and then splits the results
 * per scope for storage and coverage. Both scopes get a coverage row either way —
 * including when zero events were found — so "no manual changes" stays
 * distinguishable from "we never looked".
 */
async function pollAndPersistCloudTrail(
    tenantId: string, accountId: string, region: string,
    assumed: Parameters<typeof fetchAsgActivities>[0], runId: string, now: Date, totals: ScanTotals,
    platformRoleArn?: string
): Promise<void> {
    // Both scopes share one CloudTrail position: a single sweep advances them
    // together, so keeping separate marks would let them drift apart for no gain.
    const watermark = await getWatermark(tenantId, accountId, region, 'ecs', 'cloudtrail');
    const sinceAt = watermark.lastActivityAt
        ? new Date(watermark.lastActivityAt.getTime() - SCALING_AUDIT_CONFIG.watermarkOverlapMinutes * 60_000)
        : null;
    const windowStart = sinceAt ?? new Date(now.getTime() - SCALING_AUDIT_CONFIG.awsRetentionDays * 86400_000);

    const coverageIds = new Map<ScalingScope, string>();
    for (const scope of ECS_ASG_SCOPES) {
        coverageIds.set(
            scope,
            await createCoverageRow({ tenantId, accountId, region, scope, source: 'cloudtrail', windowStart, windowEnd: now, runId })
        );
    }

    const result = await fetchCloudTrailCapacityChanges(assumed, region, sinceAt, now, platformRoleArn);
    totals.apiCallCount += result.apiCallCount;

    if (result.error) {
        for (const scope of ECS_ASG_SCOPES) {
            await updateCoverageRow(coverageIds.get(scope)!, {
                status: 'failed', reason: result.error.reason, activityCount: 0,
                apiCallCount: result.apiCallCount, pagesFetched: result.pagesFetched, truncated: result.truncated,
            });
        }
        // AccessDenied here is NOT a quiet day — it means out-of-band changes went
        // unobserved, which must never read as "none happened".
        await upsertWatermark(tenantId, accountId, region, 'ecs', 'cloudtrail', { lastRunId: runId, success: false });
        totals.errors.push({ accountId, region, error: `cloudtrail/${result.error.reason}: ${result.error.message}` });
        return;
    }

    // Every CloudTrail row is terminal by construction (see cloudtrail-client.ts),
    // so nothing is deferred and the mark always advances.
    totals.eventsSeen += result.events.length;
    if (result.platformSkipped > 0) {
        // This platform's own scheduler acting through the customer's
        // NucleusAccess role. Those changes belong to source='platform', written
        // at mutation time with the real actor — capturing them here would label
        // automation as a human out-of-band change.
        log.info('Skipped platform-initiated CloudTrail events', { tenantId, accountId, region, skipped: result.platformSkipped });
    }

    for (const scope of ECS_ASG_SCOPES) {
        const scoped = result.events.filter((e) => (scope === 'ecs' ? !!e.serviceName : !!e.asgName));
        const inventoryIds = await getInventoryResourceIds(tenantId, accountId, scope);
        const normalized = scoped.map((raw) =>
            normalizeActivity(raw, { tenantId, accountId, region, scope, source: 'cloudtrail', inventoryResourceIds: inventoryIds })
        );
        // CloudTrail rows never carry desiredBefore (see cloudtrail-client.ts) —
        // this is the primary motivating case for the enrichment step.
        await enrichBeforeInsert(normalized, assumed, region);
        totals.eventsCaptured += await insertEvents(normalized, runId);

        await updateCoverageRow(coverageIds.get(scope)!, {
            status: result.truncated ? 'partial' : 'covered',
            reason: result.truncated ? 'max_pages_exceeded' : result.retentionClamped ? 'cloudtrail_retention_exceeded' : undefined,
            activityCount: scoped.length,
            apiCallCount: result.apiCallCount,
            pagesFetched: result.pagesFetched,
            truncated: result.truncated,
            oldestActivitySeenAt: result.oldestActivitySeenAt,
            newestActivitySeenAt: result.newestActivitySeenAt,
        });
    }

    if (result.retentionClamped) totals.gapsDetected += 1;

    const nextMark = computeWatermarkAdvance(
        result.events,
        { at: watermark.lastActivityAt, id: watermark.lastActivityId },
        result.newestActivitySeenAt
    );

    await upsertWatermark(tenantId, accountId, region, 'ecs', 'cloudtrail', {
        lastActivityAt: nextMark.at,
        lastActivityId: nextMark.id,
        lastRunId: runId,
        success: true,
        // The requested window reached past CloudTrail's ~90-day Event history
        // ceiling, so anything older is permanently unobservable — a real gap.
        gap: result.retentionClamped
            ? { fromAt: watermark.lastActivityAt, toAt: result.oldestActivitySeenAt, reason: 'cloudtrail_retention_exceeded' }
            : null,
    });
}

/**
 * Capture out-of-band capacity changes from CloudTrail for ONE of
 * SINGLE_SCOPE_CLOUDTRAIL_SCOPES — unlike pollAndPersistCloudTrail (ecs/asg's
 * shared sweep), each of these scopes has its own single-scope CloudTrail
 * fetcher, so there is no splitting step: every event the fetcher returns
 * already belongs to this one scope.
 */
async function pollAndPersistSingleScopeCloudTrail(
    tenantId: string, accountId: string, region: string, scope: 'rds' | 'docdb' | 'msk' | 'elasticache',
    assumed: AssumedCredentials, runId: string, now: Date, totals: ScanTotals,
    platformRoleArn?: string
): Promise<void> {
    const watermark = await getWatermark(tenantId, accountId, region, scope, 'cloudtrail');
    const sinceAt = watermark.lastActivityAt
        ? new Date(watermark.lastActivityAt.getTime() - SCALING_AUDIT_CONFIG.watermarkOverlapMinutes * 60_000)
        : null;
    const windowStart = sinceAt ?? new Date(now.getTime() - SCALING_AUDIT_CONFIG.awsRetentionDays * 86400_000);

    const coverageId = await createCoverageRow({ tenantId, accountId, region, scope, source: 'cloudtrail', windowStart, windowEnd: now, runId });

    const result = await pollSingleScopeCloudTrail(scope, assumed, region, sinceAt, now, platformRoleArn);
    totals.apiCallCount += result.apiCallCount;

    if (result.error) {
        await updateCoverageRow(coverageId, {
            status: 'failed', reason: result.error.reason, activityCount: 0,
            apiCallCount: result.apiCallCount, pagesFetched: result.pagesFetched, truncated: result.truncated,
        });
        // AccessDenied here is NOT a quiet day — it means out-of-band changes went
        // unobserved, which must never read as "none happened".
        await upsertWatermark(tenantId, accountId, region, scope, 'cloudtrail', { lastRunId: runId, success: false });
        totals.errors.push({ accountId, region, scope, error: `cloudtrail/${result.error.reason}: ${result.error.message}` });
        return;
    }

    // Every CloudTrail row is terminal by construction (see cloudtrail-client.ts),
    // so nothing is deferred and the mark always advances.
    totals.eventsSeen += result.events.length;
    if (result.platformSkipped > 0) {
        log.info('Skipped platform-initiated CloudTrail events', { tenantId, accountId, region, scope, skipped: result.platformSkipped });
    }

    // No inventory-match lookup — RDS/MSK/ElastiCache/DocDB live under
    // different inventory resource types this job was never built to match
    // (see the identical note in pollAndPersistScope).
    const normalized = result.events.map((raw) =>
        normalizeActivity(raw, { tenantId, accountId, region, scope, source: 'cloudtrail', inventoryResourceIds: new Set<string>() })
    );
    // No CloudWatch enrichment here either — that step backfills ecs/asg-only
    // metrics (DesiredTaskCount, CPU/Mem) that don't exist for these scopes.
    totals.eventsCaptured += await insertEvents(normalized, runId);

    await updateCoverageRow(coverageId, {
        status: result.truncated ? 'partial' : 'covered',
        reason: result.truncated ? 'max_pages_exceeded' : result.retentionClamped ? 'cloudtrail_retention_exceeded' : undefined,
        activityCount: result.events.length,
        apiCallCount: result.apiCallCount,
        pagesFetched: result.pagesFetched,
        truncated: result.truncated,
        oldestActivitySeenAt: result.oldestActivitySeenAt,
        newestActivitySeenAt: result.newestActivitySeenAt,
    });

    if (result.retentionClamped) totals.gapsDetected += 1;

    const nextMark = computeWatermarkAdvance(
        result.events,
        { at: watermark.lastActivityAt, id: watermark.lastActivityId },
        result.newestActivitySeenAt
    );

    await upsertWatermark(tenantId, accountId, region, scope, 'cloudtrail', {
        lastActivityAt: nextMark.at,
        lastActivityId: nextMark.id,
        lastRunId: runId,
        success: true,
        gap: result.retentionClamped
            ? { fromAt: watermark.lastActivityAt, toAt: result.oldestActivitySeenAt, reason: 'cloudtrail_retention_exceeded' }
            : null,
    });
}

/**
 * Best-effort Network Pulse collection (DX connections + VPN tunnels) for one
 * account/region: discover what exists, pull hourly CloudWatch bandwidth for
 * it over a fixed lookback window, and upsert. Never throws — a DX/VPN
 * discovery or CloudWatch outage must not abort the scope polling around it,
 * which is why every failure is caught and logged rather than propagated.
 * Unlike scope polling this has no watermark/coverage tracking of its own:
 * upsertNetworkLinkSamples is itself idempotent per (resourceType, resourceId,
 * bucketStartUtc), so simply re-querying the full lookback window every scan
 * is sufficient.
 */
async function collectNetworkLinkSamples(tenantId: string, accountId: string, region: string, assumed: AssumedCredentials, now: Date): Promise<void> {
    try {
        const [dxConnections, vpnTunnels] = await Promise.all([
            fetchDirectConnectConnections(assumed, region),
            fetchVpnTunnels(assumed, region),
        ]);
        if (!dxConnections.length && !vpnTunnels.length) return;

        const resources: NetworkResourceRef[] = [
            ...dxConnections.map((c) => ({
                resourceType: 'dx_connection' as const,
                resourceId: c.resourceId,
                connectionId: c.resourceId,
                virtualInterfaceIds: c.virtualInterfaceIds,
            })),
            ...vpnTunnels.map((t) => ({
                resourceType: 'vpn_tunnel' as const,
                resourceId: t.resourceId,
                vpnConnectionId: t.vpnConnectionId,
                outsideIpAddress: t.outsideIpAddress,
            })),
        ];
        // displayName falls back to resourceId at read time (per schema doc
        // comment) — kept undefined here rather than duplicating that fallback.
        const metaByResourceId = new Map(
            [...dxConnections, ...vpnTunnels].map((r) => [r.resourceId, { displayName: r.displayName, installedBandwidthMbps: r.installedBandwidthMbps }])
        );

        // Floored to the current UTC hour so every scan run — whatever minute
        // it happens to fire at — asks CloudWatch for the SAME bucket grid.
        // GetMetricData's hourly buckets are anchored to the query's endTime,
        // not to a fixed wall-clock grid: passing the exact "now" moment here
        // would shift the whole grid on every run, so the upsert's ON CONFLICT
        // (tenantId, resourceType, resourceId, bucketStartUtc) never matches
        // an existing row — each re-scan just adds a fresh, differently-offset
        // set of "hourly" rows for the same real hours, inflating an uptime
        // count (distinct-buckets-seen-up / nominal-hours-in-window) past
        // 100% with every re-scan instead of refreshing the same rows.
        const endTime = new Date(Math.floor(now.getTime() / 3600_000) * 3600_000);
        const startTime = new Date(endTime.getTime() - SCALING_AUDIT_CONFIG.networkLinkLookbackDays * 86400_000);
        const buckets = await fetchNetworkUtilization(assumed, region, resources, startTime, endTime);

        const samples = resources.flatMap((resource) => {
            const meta = metaByResourceId.get(resource.resourceId);
            return (buckets.get(resource.resourceId) ?? []).map((bucket) => ({
                accountId,
                region,
                resourceType: resource.resourceType,
                resourceId: resource.resourceId,
                displayName: meta?.displayName ?? null,
                installedBandwidthMbps: meta?.installedBandwidthMbps ?? null,
                bpsAvgIn: bucket.bpsAvgIn ?? null,
                bpsMaxIn: bucket.bpsMaxIn ?? null,
                bpsAvgOut: bucket.bpsAvgOut ?? null,
                bpsMaxOut: bucket.bpsMaxOut ?? null,
                stateUp: bucket.stateUp ?? null,
                bucketStartUtc: bucket.bucketStartUtc,
            }));
        });
        if (samples.length) await upsertNetworkLinkSamples(tenantId, samples);
    } catch (err) {
        log.warn('Network Pulse (DX/VPN) collection failed — continuing scan', { tenantId, accountId, region, error: String(err) });
    }
}

export async function register(boss: PgBoss, executor: JobExecutor): Promise<void> {
    if (env.SCALING_AUDIT_ENABLED !== 'true') {
        log.info('SCALING_AUDIT_ENABLED is not "true" — Scaling Audit not registered');
        return;
    }

    executor.registerHandler?.(SCAN, handleScan);

    await boss.createQueue(FAN_OUT);
    await boss.updateQueue(FAN_OUT, { name: FAN_OUT, retryLimit: 1, expireInSeconds: 300, deadLetter: DEAD_LETTER_QUEUE });

    // Read-only analysis (aws_api rows) + non-fatal audit writes (platform rows,
    // see the scheduler call sites) — retries are safe.
    await ensureStatelyScanQueue(boss, SCAN, log, { expireInSeconds: 3600, retryLimit: 2 });

    await boss.schedule(FAN_OUT, SCALING_AUDIT_CONFIG.cron, {}, { tz: 'UTC' });

    await boss.work(FAN_OUT, { batchSize: 1 }, async () => {
        const tenants = await getAllTenants();
        let dispatched = 0;
        for (const tenant of tenants) {
            const outcome = await dispatchTenantScan({
                boss,
                scanQueue: SCAN,
                tenantId: tenant.id,
                jobType: 'scaling-audit-cron',
                minIntervalMs: 20 * 60 * 60 * 1000, // 20h — daily cadence, no per-tenant config
                payload: { tenantId: tenant.id, trigger: 'schedule' } satisfies ScalingAuditScanJob,
                log,
                sendOptions: { retryLimit: 2, retryDelay: 60, retryBackoff: true },
            });
            if (outcome === 'dispatched') dispatched++;
        }
        log.info('Scaling-audit fan-out complete', { tenantCount: tenants.length, dispatched });

        // Seal every SETTLED unsealed day, not just yesterday. Sealing only
        // yesterday left backfilled history (up to 90 days of it) permanently
        // unsealed, and sealed days that were still being written to — producing
        // stale seals that can never be corrected and read as tampering. See
        // daily-seal.ts for all three defects this replaces.
        for (const tenant of tenants) {
            await sealPendingDays(tenant.id)
                .then((r) => {
                    // Never silent: a tenant that could not be sealed says why.
                    if (r.blockedReason) log.info('Sealing skipped', { tenantId: tenant.id, reason: r.blockedReason });
                })
                .catch((err) => log.warn('Daily seal failed', { tenantId: tenant.id, error: String(err) }));
        }
    });

    await boss.work<ScalingAuditScanJob>(SCAN, { batchSize: 1 }, async ([job]) => {
        await executor.execute(SCAN, job.data, {
            idempotencyKey: job.id,
            timeoutMs: (3600 - 60) * 1000,
        });
    });

    log.info('Registered queues', { queues: [FAN_OUT, SCAN], cron: SCALING_AUDIT_CONFIG.cron });
}

/** Enqueue an on-demand scan for a tenant. Returns null if one is already queued/active. */
export async function enqueueScalingAuditScan(boss: PgBoss, tenantId: string): Promise<string | null> {
    if (await hasActiveRun(tenantId)) return null;
    return boss.send(
        SCAN,
        { tenantId, trigger: 'manual' } satisfies ScalingAuditScanJob,
        { singletonKey: `tenant:${tenantId}`, retryLimit: 2, retryDelay: 60, retryBackoff: true }
    );
}
