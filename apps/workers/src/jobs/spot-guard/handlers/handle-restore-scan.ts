// workers/src/jobs/spot-guard/handlers/handle-restore-scan.ts
//
// Hourly per-tenant restore scan (SG-008) — the port of the reference's reverter Lambda.
//
// Runs THROUGH the executor (unlike the event handler): this walks a whole tenant's
// estate, assuming a role and calling DescribeServices per service, so it is minutes of
// work and benefits from the executor's isolation and its startedBy idempotent-adopt.
//
// The queue is registered with retryLimit 0 because every restore is an
// ecs:UpdateService with forceNewDeployment — a retry would bounce production tasks a
// second time. The next hourly tick IS the retry. Same choice as scheduler-scan, and
// deliberately unlike read-only right-sizing-scan.
import { createLogger } from '../../../lib/logger.js';
import { writeAuditLog } from '../../discovery/services/audit-service.js';
import { SPOT_GUARD_CONFIG } from '../config.js';
import type { SpotGuardRestoreScanJob, SpokeBinding } from '../types.js';
import { computeBackoffUntil, evaluateRestore } from '../services/engine.js';
import {
    armBackoffOnly,
    countRestoresInLast24h,
    listRestoreCandidates,
    recordAppliedStrategy,
    recordRestoreSuccess,
    upsertObservedService,
    writeEvent,
    claimAction,
    type SpotServiceRow,
} from '../services/db-writer.js';
import { notify } from '../services/notifier.js';
import {
    createSpokeClients,
    describeServiceState,
    enforceDeregistrationDelay,
    updateCapacityProvider,
} from '../services/ecs-client.js';
import { getPool } from '../../discovery/services/db.js';

const log = createLogger('spot-guard-restore');

/** The tenant's binding for one account, so we can assume the right role. */
async function findBinding(tenantId: string, accountId: string): Promise<SpokeBinding | null> {
    const client = await getPool().connect();
    try {
        const { rows } = await client.query<SpokeBinding>(
            `SELECT "tenantId", "accountId", "roleArn", "externalId", regions
               FROM accounts
              WHERE "tenantId" = $1 AND "accountId" = $2 AND active = true AND "spotAutomationEnabled" = true`,
            [tenantId, accountId],
        );
        return rows[0] ?? null;
    } finally {
        client.release();
    }
}

/**
 * True when this tenant is the acting tenant for the service's AWS account.
 *
 * Prevents two tenants that both onboarded the same AWS account from each restoring the
 * same ECS service to their own saved baseline — which would flap the service once an
 * hour, forever. The election is the same deterministic tenantId-ASC rule the event path
 * uses, so both paths agree without coordinating.
 */
async function isActingTenant(tenantId: string, accountId: string): Promise<boolean> {
    const client = await getPool().connect();
    try {
        const { rows } = await client.query<{ tenantId: string }>(
            `SELECT "tenantId" FROM accounts
              WHERE "accountId" = $1 AND active = true AND "spotAutomationEnabled" = true
              ORDER BY "tenantId" ASC LIMIT 1`,
            [accountId],
        );
        return rows[0]?.tenantId === tenantId;
    } finally {
        client.release();
    }
}

export async function handleSpotGuardRestoreScan(jobData: unknown): Promise<void> {
    const { tenantId, trigger, serviceIds, force } = jobData as SpotGuardRestoreScanJob;

    const candidates = await listRestoreCandidates({ tenantId, serviceIds, force });
    if (candidates.length === 0) {
        log.info('No restore candidates', { tenantId, trigger });
        return;
    }

    let restored = 0;
    let skipped = 0;
    let failed = 0;

    for (const row of candidates) {
        try {
            const outcome = await restoreOne(row, { force: Boolean(force), trigger });
            if (outcome === 'restored') restored += 1;
            else skipped += 1;
        } catch (err) {
            failed += 1;
            // One service's failure must never abort the rest of the tenant's estate.
            log.error('Restore failed for service', {
                tenantId,
                serviceName: row.serviceName,
                error: err instanceof Error ? err.message : String(err),
            });
            await onRestoreFailure(row, err);
        }
    }

    await writeAuditLog({
        tenantId,
        eventType: 'spot_guard.restore.scan_completed',
        action: 'Spot Guard restore scan completed',
        resourceId: `spot-guard-restore-${tenantId}`,
        status: failed > 0 ? 'partial' : 'success',
        severity: 'info',
        details: `Evaluated ${candidates.length} service(s): ${restored} restored, ${skipped} skipped, ${failed} failed.`,
        metadata: { trigger, restored, skipped, failed, forced: Boolean(force) },
    });

    log.info('Restore scan complete', { tenantId, trigger, candidates: candidates.length, restored, skipped, failed });
}

/**
 * Record a skip.
 *
 * A MANUAL skip always gets a timeline row, whatever the reason. The user clicked "Restore now"
 * and is waiting for an answer, so "we decided not to act, here is why" IS the answer — silence
 * reads as a broken button. A SCHEDULED skip keeps the original behaviour: only the interesting
 * reasons are recorded, because 'nothing_to_do' fires every hour for every healthy service and
 * would bury real events in the feed.
 *
 * eventType is deliberately limited to the two existing skip values. `spot_guard_events.eventType`
 * is pinned by spot_guard_events_event_type_check, so inventing a type here would need a
 * migration; the specific reason travels in `message` instead.
 */
/**
 * Skip reasons that a SCHEDULED pass must not write a timeline row for.
 *
 * Both describe a steady, expected state rather than an event, and both recur on every hourly pass
 * for as long as they hold — so recording them buries the real events the feed exists to show.
 *
 * `nothing_to_do` — the service is already on Spot. Fires for every healthy managed service, hourly.
 *
 * `scheduler_protection` — the service is at desiredCount 0, almost always because Nucleus's own
 * Cost Scheduler scaled it down. Non-prod environments are commonly shut down overnight, which
 * makes EVERY managed service hit this on EVERY pass for the whole shutdown window: one row per
 * service per hour, all night, saying nothing except "still switched off". A ten-hour shutdown
 * across nine services is ninety rows of noise per night.
 *
 * A MANUAL trigger still records both. Someone pressed a button and is owed an answer, and the
 * volume argument does not apply to one deliberate click.
 */
const QUIET_SCHEDULED_SKIPS = new Set(['nothing_to_do', 'scheduler_protection']);

async function noteSkip(
    row: SpotServiceRow,
    reason: string,
    trigger: 'schedule' | 'manual',
    detail?: Record<string, unknown>,
): Promise<'skipped'> {
    // info, not debug: deployments run at LOG_LEVEL=info, and a skip we cannot see is a skip we
    // cannot diagnose. Volume is one line per managed service per pass, so this is affordable.
    log.info('Restore skipped', { tenantId: row.tenantId, serviceName: row.serviceName, reason, trigger, ...detail });

    if (trigger === 'manual' || !QUIET_SCHEDULED_SKIPS.has(reason)) {
        await writeEvent({
            tenantId: row.tenantId,
            spotServiceId: row.id,
            accountId: row.accountId,
            region: row.region,
            clusterName: row.clusterName,
            serviceName: row.serviceName,
            eventType: reason === 'backoff' ? 'backoff_skip' : 'governance_skip',
            severity: 'info',
            message: `Restore skipped: ${reason}.`,
        });
    }
    return 'skipped';
}

async function restoreOne(
    row: SpotServiceRow,
    opts: { force: boolean; trigger: 'schedule' | 'manual' },
): Promise<'restored' | 'skipped'> {
    // Only the acting tenant may mutate a shared AWS account's service.
    if (!(await isActingTenant(row.tenantId, row.accountId))) {
        return noteSkip(row, 'not_acting_tenant', opts.trigger, { accountId: row.accountId });
    }

    const binding = await findBinding(row.tenantId, row.accountId);
    if (!binding) {
        // Still warn: unlike the other skips this usually means misconfiguration (the account was
        // deactivated or Spot was turned off) rather than a deliberate safety decision.
        log.warn('No active Spot-enabled account binding — skipping', {
            tenantId: row.tenantId,
            accountId: row.accountId,
        });
        return noteSkip(row, 'no_active_account_binding', opts.trigger, { accountId: row.accountId });
    }

    const clients = await createSpokeClients(binding, row.region);
    const described = await describeServiceState(clients.ecs, row.clusterName, row.serviceName);

    // Keep the registry honest about what we saw, even when we decide not to act.
    if (described) {
        await upsertObservedService({
            tenantId: row.tenantId,
            accountId: row.accountId,
            region: row.region,
            clusterName: row.clusterName,
            serviceName: row.serviceName,
            observedStrategy: described.state.currentStrategy,
            capacityState:
                described.state.currentStrategy.length === 0
                    ? 'unknown'
                    : row.capacityState, // recomputed below by the engine's view
            desiredCount: described.state.desiredCount,
            runningCount: described.state.runningCount,
            serviceStatus: described.state.status,
        });
    }

    const decision = evaluateRestore(
        {
            managementState: row.managementState,
            desiredStrategy: row.desiredStrategy ?? [],
            restorePending: row.restorePending,
            backoffUntilMs: row.backoffUntil ? new Date(row.backoffUntil).getTime() : null,
            restoresInLast24h: await countRestoresInLast24h({ tenantId: row.tenantId, serviceId: row.id }),
            nowMs: Date.now(),
            force: opts.force,
            live: described?.state ?? null,
        },
        SPOT_GUARD_CONFIG,
    );

    if (decision.action === 'skip') {
        return noteSkip(row, decision.reason, opts.trigger);
    }

    // Exactly-once across replicas and across tenants sharing the account.
    const clusterArn = described?.raw.clusterArn ?? `arn:aws:ecs:${row.region}:${row.accountId}:cluster/${row.clusterName}`;
    const claimed = await claimAction({
        accountId: row.accountId,
        clusterArn,
        serviceName: row.serviceName,
        action: 'restore',
        actingTenant: row.tenantId,
    });
    if (!claimed) {
        return noteSkip(row, 'already_claimed_this_minute', opts.trigger);
    }

    await notify({
        tenantId: row.tenantId,
        spotServiceId: row.id,
        accountId: row.accountId,
        region: row.region,
        clusterName: row.clusterName,
        serviceName: row.serviceName,
        eventType: 'restore_attempted',
        severity: 'info',
        // 3600s window — the widest in the taxonomy, because a persistently
        // capacity-starved service would otherwise alert on every hourly pass.
        alertType: 'restore_attempt',
        strategyBefore: described?.state.currentStrategy ?? null,
        strategyAfter: decision.strategy,
        message: `Attempting to restore ${row.serviceName} to Spot capacity.`,
        slackText: `:seedling: Attempting to restore *${row.serviceName}* (\`${row.accountId}\`, ${row.region}) back to Spot capacity.`,
    });

    await updateCapacityProvider(clients.ecs, row.clusterName, row.serviceName, decision.strategy);

    // The upsert above recorded the PRE-restore strategy, because that is what the engine needed
    // to decide. Overwrite it now that the change has landed, or the row keeps claiming the
    // service is still in fallback.
    await recordAppliedStrategy({
        tenantId: row.tenantId,
        serviceId: row.id,
        appliedStrategy: decision.strategy,
    });

    if (decision.enforceAlbDelay && described) {
        await enforceDeregistrationDelay(clients.elbv2, described.raw);
    }

    await recordRestoreSuccess({
        tenantId: row.tenantId,
        serviceId: row.id,
        // Persist the hardened baseline when the engine says it drifted. The reference
        // hardened in memory only and recomputed the same fix every hour forever.
        hardenedStrategy: decision.persistDesiredStrategy ? decision.strategy : undefined,
    });

    // No alertType: the observer path already emits a 'recovery' alert when the task
    // actually comes up on Spot. Alerting here too would double-notify for one logical
    // event — and this one is only "the API call succeeded", which is weaker news.
    await notify({
        tenantId: row.tenantId,
        spotServiceId: row.id,
        accountId: row.accountId,
        region: row.region,
        clusterName: row.clusterName,
        serviceName: row.serviceName,
        eventType: 'restore_succeeded',
        severity: 'info',
        fromCapacity: 'on_demand',
        toCapacity: 'spot',
        strategyAfter: decision.strategy,
        message: `${row.serviceName} restored to Spot capacity.`,
        metadata: { strategy: decision.strategy },
        audit: {
            eventType: 'spot_guard.restore.applied',
            action: 'Restored ECS service to Fargate Spot',
            severity: 'medium',
            details: `Restored ${row.serviceName} to Spot capacity in ${row.clusterName} (${row.region}).`,
        },
    });

    return 'restored';
}

/** Arm the backoff and record the failure so the next pass waits longer. */
async function onRestoreFailure(row: SpotServiceRow, err: unknown): Promise<void> {
    const backoffUntil = computeBackoffUntil(row.consecutiveFailures + 1, Date.now(), SPOT_GUARD_CONFIG);
    await armBackoffOnly({ tenantId: row.tenantId, serviceId: row.id, backoffUntil });
    await notify({
        tenantId: row.tenantId,
        spotServiceId: row.id,
        accountId: row.accountId,
        region: row.region,
        clusterName: row.clusterName,
        serviceName: row.serviceName,
        eventType: 'restore_failed',
        severity: 'critical',
        // New in this port — the reference never alerted on a failed restore at all, so a
        // service could sit on expensive On-Demand indefinitely with nobody told.
        alertType: 'restore_failed',
        message: `Restore failed: ${err instanceof Error ? err.message : String(err)}. Backing off until ${backoffUntil.toISOString()}.`,
        slackText: `:x: Restore to Spot FAILED for *${row.serviceName}* (\`${row.accountId}\`, ${row.region}): ${err instanceof Error ? err.message : String(err)}. Backing off until ${backoffUntil.toISOString()}.`,
        metadata: { backoffUntil: backoffUntil.toISOString() },
    });
}
