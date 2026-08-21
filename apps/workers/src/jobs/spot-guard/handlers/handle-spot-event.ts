// workers/src/jobs/spot-guard/handlers/handle-spot-event.ts
//
// The pg-boss handler for one inbound ECS event (SG-007).
//
// RUNS IN-PROCESS, NOT VIA THE EXECUTOR. In production WORKER_ARCH=horizontal, so
// executor.execute() launches one ephemeral Fargate task per job: ~30-90s wall clock and
// ~$0.0013 each. A single busy 20-service cluster emits roughly 4,800 ECS Task State
// Change events a day, which through the executor would be ~$6.30/day/account of Fargate
// to perform a few hundred milliseconds of real work — and, decisively, would blow the
// ~2 minute Spot interruption window on every single event. See register() in ../index.ts.
//
// EXACTLY-ONCE MUTATION, IN FOUR LAYERS
//   1. Deterministic acting-tenant election (account-resolver) — no coordination needed.
//   2. Atomic minute-window claim in spot_guard_actions — cross-tenant by design.
//   3. The engine's live-AWS-state idempotency guard. STRONGEST layer, because it derives
//      from what AWS actually reports rather than from our own bookkeeping, so it holds
//      even if 1 and 2 both fail: the winner flips Spot weight to 0, then every loser's
//      DescribeServices shows no active Spot and no-ops.
//   4. Write ordering — the restore baseline is persisted BEFORE UpdateService, and only
//      when active Spot exists, so a partial failure can never poison it.
//
// Observability rows are written for EVERY owning tenant; only the mutation is elected.
// Both tenants paid for that account, and withholding the timeline from one because the
// other sorted first would be silent data loss.
import { createLogger } from '../../../lib/logger.js';
import { SPOT_GUARD_CONFIG } from '../config.js';
import type {
    EcsEventEnvelope,
    SpotGuardEventJob,
    CapacityType,
    LiveServiceState,
    SpokeBinding,
} from '../types.js';
import { authorizeEvent } from '../services/account-resolver.js';
import {
    classifyCapacity,
    computeBackoffUntil,
    deriveCapacityState,
    deriveCapacityTransition,
    evaluatePlacementFailure,
    isEventActionable,
} from '../services/engine.js';
import {
    armBackoffOnly,
    claimAction,
    claimInterruptionHandling,
    closeSession,
    findService,
    openSession,
    recordAppliedStrategy,
    recordFallback,
    recordInterruption,
    upsertObservedService,
    writeEvent,
} from '../services/db-writer.js';
import {
    createSpokeClients,
    describeServiceState,
    enforceDeregistrationDelay,
    preDrainTaskFromAlb,
    resolveTaskSize,
    updateCapacityProvider,
} from '../services/ecs-client.js';
import { notify } from '../services/notifier.js';

const log = createLogger('spot-guard-event');

/** Interruption detection. Broader than the reference's exact-string rule on purpose. */
function isSpotInterruption(detail: EcsEventEnvelope['detail']): boolean {
    const stopCode = detail?.stopCode ?? '';
    const reason = detail?.stoppedReason ?? '';
    // The reference's interruption RULE matched only the exact string "Your Spot Task was
    // interrupted.", while its observer ALSO accepted stopCode SpotInterruption or any
    // reason containing "interrupted". Taking the broader form: a missed interruption
    // means user-visible 5xx, whereas a false positive only costs one redundant
    // deregistration of a task that is stopping anyway.
    return (
        stopCode === 'SpotInterruption' ||
        stopCode === 'SpotInstanceInterruption' ||
        /interrupted/i.test(reason)
    );
}

/** "service:api" -> "api". Standalone (RunTask) tasks have no service and are skipped. */
function serviceNameFromGroup(group?: string): string | null {
    if (!group || !group.startsWith('service:')) return null;
    const name = group.slice('service:'.length);
    return name.length > 0 ? name : null;
}

function clusterNameFromArn(clusterArn?: string): string | null {
    if (!clusterArn) return null;
    const name = clusterArn.split('/').pop();
    return name && name.length > 0 ? name : null;
}

function regionFromArn(arn?: string): string | null {
    if (!arn) return null;
    const parts = arn.split(':');
    return parts.length > 3 && parts[3] ? parts[3] : null;
}

interface EventContext {
    envelope: EcsEventEnvelope;
    bindings: SpokeBinding[];
    acting: SpokeBinding;
    accountId: string;
    region: string;
    clusterArn: string;
    clusterName: string;
    serviceName: string;
    sourceEventId: string | null;
    occurredAt: Date;
    ageMs: number;
}

export async function handleSpotGuardEvent(jobData: unknown): Promise<void> {
    const { envelope, ingestedAtMs } = jobData as SpotGuardEventJob;
    const detail = envelope.detail ?? {};

    // ── Authorization first, before any other work ────────────────────────────
    const auth = await authorizeEvent(envelope);
    if (!auth.ok) return; // resolver already logged with the right metric

    const clusterArn = detail.clusterArn;
    const clusterName = clusterNameFromArn(clusterArn);
    const serviceName = serviceNameFromGroup(detail.group) ?? serviceNameFromResources(envelope);

    if (!clusterArn || !clusterName || !serviceName) {
        // Standalone RunTask tasks and events we cannot attribute to a service are not
        // errors — the reference skipped them too. Nothing to manage.
        log.debug('Event not attributable to an ECS service — skipping', {
            detailType: envelope['detail-type'],
            group: detail.group,
        });
        return;
    }

    const region = regionFromArn(clusterArn) ?? envelope.region ?? 'unknown';
    const occurredAt = parseDate(detail.stoppedAt ?? detail.startedAt ?? envelope.time) ?? new Date(ingestedAtMs);

    const ctx: EventContext = {
        envelope,
        bindings: auth.bindings,
        acting: auth.acting,
        accountId: envelope.account!,
        region,
        clusterArn,
        clusterName,
        serviceName,
        sourceEventId: envelope.id ?? null,
        occurredAt,
        ageMs: Date.now() - occurredAt.getTime(),
    };

    const detailType = envelope['detail-type'];

    if (detailType === 'ECS Service Action' || detailType === 'ECS Deployment State Change') {
        if (detail.eventName === 'SERVICE_TASK_PLACEMENT_FAILURE') {
            await handlePlacementFailure(ctx);
        }
        return;
    }

    if (detailType === 'ECS Task State Change') {
        // Interruption and task-state accounting are INDEPENDENT: an interrupted task
        // still needs its session closed for the hours report, so both run.
        if (isSpotInterruption(detail)) await handleInterruption(ctx);
        await handleTaskStateChange(ctx);
        return;
    }

    log.debug('Unhandled detail-type — ignored', { detailType });
}

/** Fallback for events that carry the service in resources[] rather than detail.group. */
function serviceNameFromResources(envelope: EcsEventEnvelope): string | null {
    for (const arn of envelope.resources ?? []) {
        // arn:aws:ecs:region:acct:service/cluster/service-name
        const m = /:service\/[^/]+\/([^/]+)$/.exec(arn);
        if (m?.[1]) return m[1];
    }
    return null;
}

function parseDate(value?: string): Date | null {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

// ── Placement failure → fall back to On-Demand ───────────────────────────────

async function handlePlacementFailure(ctx: EventContext): Promise<void> {
    const clients = await createSpokeClients(ctx.acting, ctx.region);
    const described = await describeServiceState(clients.ecs, ctx.clusterName, ctx.serviceName);

    if (!described) {
        log.info('Service not found for placement failure — skipping', {
            clusterName: ctx.clusterName,
            serviceName: ctx.serviceName,
        });
        return;
    }

    const capacityState = deriveCapacityState(described.state.currentStrategy);

    // Record what we see for every owning tenant, and note the failure on the timeline
    // regardless of what we decide to do about it.
    const serviceIds = new Map<string, string>();
    for (const binding of ctx.bindings) {
        const serviceId = await upsertObservedService({
            tenantId: binding.tenantId,
            accountId: ctx.accountId,
            region: ctx.region,
            clusterName: ctx.clusterName,
            serviceName: ctx.serviceName,
            clusterArn: ctx.clusterArn,
            observedStrategy: described.state.currentStrategy,
            capacityState,
            desiredCount: described.state.desiredCount,
            runningCount: described.state.runningCount,
            serviceStatus: described.state.status,
        });
        serviceIds.set(binding.tenantId, serviceId);

        await notify({
            tenantId: binding.tenantId,
            spotServiceId: serviceId,
            accountId: ctx.accountId,
            region: ctx.region,
            clusterName: ctx.clusterName,
            serviceName: ctx.serviceName,
            eventType: 'placement_failure',
            severity: 'critical',
            alertType: 'placement_failure',
            sourceEventId: ctx.sourceEventId,
            strategyBefore: described.state.currentStrategy,
            message: `Spot capacity unavailable for ${ctx.serviceName}; evaluating fallback to On-Demand.`,
            slackText: `:rotating_light: Placement failure for *${ctx.serviceName}* in *${ctx.clusterName}* (\`${ctx.accountId}\`, ${ctx.region}). Spot capacity is unavailable — attempting fallback to On-Demand.`,
            occurredAt: ctx.occurredAt,
            metadata: { reason: ctx.envelope.detail?.reason, actingTenant: ctx.acting.tenantId },
        });
    }

    const decision = evaluatePlacementFailure(
        {
            currentStrategy: described.state.currentStrategy,
            serviceStatus: described.state.status,
            deploymentInProgress: described.state.deploymentInProgress,
        },
        SPOT_GUARD_CONFIG,
    );

    // The backoff must be armed even when we skip — this is the restore-thrashing fix.
    if (decision.stampBackoff) {
        for (const binding of ctx.bindings) {
            const serviceId = serviceIds.get(binding.tenantId);
            if (!serviceId) continue;
            const existing = await findService({
                tenantId: binding.tenantId,
                accountId: ctx.accountId,
                region: ctx.region,
                clusterName: ctx.clusterName,
                serviceName: ctx.serviceName,
            });
            const backoffUntil = computeBackoffUntil(
                (existing?.consecutiveFailures ?? 0) + 1,
                Date.now(),
                SPOT_GUARD_CONFIG,
            );

            if (decision.action === 'apply_fallback') {
                await recordFallback({
                    tenantId: binding.tenantId,
                    serviceId,
                    desiredStrategy: decision.desiredStrategy,
                    backoffUntil,
                });
            } else {
                // Skip path: arm the backoff WITHOUT touching desiredStrategy, so a
                // failed strategy can never become the restore baseline.
                await armBackoffOnly({ tenantId: binding.tenantId, serviceId, backoffUntil });
            }
        }
    }

    if (decision.action !== 'apply_fallback') {
        log.info('Placement failure handled without a capacity change', {
            reason: decision.reason,
            serviceName: ctx.serviceName,
        });
        for (const binding of ctx.bindings) {
            await writeEvent({
                tenantId: binding.tenantId,
                spotServiceId: serviceIds.get(binding.tenantId) ?? null,
                accountId: ctx.accountId,
                region: ctx.region,
                clusterName: ctx.clusterName,
                serviceName: ctx.serviceName,
                eventType: decision.reason === 'already_on_demand' ? 'backoff_skip' : 'governance_skip',
                severity: 'info',
                sourceEventId: ctx.sourceEventId ? `${ctx.sourceEventId}:skip` : null,
                message: `Fallback skipped: ${decision.reason}.`,
                occurredAt: ctx.occurredAt,
            });
        }
        return;
    }

    // Layer 2: only one worker/tenant proceeds to mutate.
    const claimed = await claimAction({
        accountId: ctx.accountId,
        clusterArn: ctx.clusterArn,
        serviceName: ctx.serviceName,
        action: 'fallback',
        actingTenant: ctx.acting.tenantId,
    });
    if (!claimed) {
        log.info('Fallback already claimed this minute — skipping duplicate mutation', {
            serviceName: ctx.serviceName,
        });
        return;
    }

    await updateCapacityProvider(clients.ecs, ctx.clusterName, ctx.serviceName, decision.fallbackStrategy);

    for (const binding of ctx.bindings) {
        // Per binding, not once: several tenants can share one AWS account, and each keeps its own
        // registry row for the same service. Cannot be folded into recordFallback above — that runs
        // BEFORE the claim, so at that point the mutation may still not happen at all.
        const serviceId = serviceIds.get(binding.tenantId);
        if (serviceId) {
            await recordAppliedStrategy({
                tenantId: binding.tenantId,
                serviceId,
                appliedStrategy: decision.fallbackStrategy,
            });
        }

        await notify({
            tenantId: binding.tenantId,
            spotServiceId: serviceIds.get(binding.tenantId) ?? null,
            accountId: ctx.accountId,
            region: ctx.region,
            clusterName: ctx.clusterName,
            serviceName: ctx.serviceName,
            eventType: 'fallback_applied',
            severity: 'warning',
            // 'remediation' in the reference's taxonomy — the "we fixed it" alert, with its
            // own 300s window separate from the failure alert above.
            alertType: 'remediation',
            sourceEventId: ctx.sourceEventId ? `${ctx.sourceEventId}:fallback` : null,
            fromCapacity: 'spot',
            toCapacity: 'on_demand',
            strategyBefore: described.state.currentStrategy,
            strategyAfter: decision.fallbackStrategy,
            message: `Switched ${ctx.serviceName} to On-Demand capacity.`,
            slackText: `:white_check_mark: Auto-remediation: switched *${ctx.serviceName}* to On-Demand capacity (\`${ctx.accountId}\`, ${ctx.region}). Nucleus will attempt to restore it to Spot automatically.`,
            occurredAt: new Date(),
            metadata: { actingTenant: ctx.acting.tenantId },
            // The only AWS mutation on this path, so this is where the audit entry belongs.
            audit: {
                eventType: 'spot_guard.fallback.applied',
                action: 'Switched ECS service to Fargate On-Demand',
                severity: 'high',
                details: `Spot capacity unavailable for ${ctx.serviceName}; switched to On-Demand in ${ctx.clusterName} (${ctx.region}).`,
            },
        });
    }
}

// ── Spot interruption → ALB pre-drain ────────────────────────────────────────

async function handleInterruption(ctx: EventContext): Promise<void> {
    const taskArn = ctx.envelope.detail?.taskArn;
    if (!taskArn) return;

    const capacityType: CapacityType = classifyCapacity(ctx.envelope.detail?.capacityProviderName);

    // Per-task exactly-once, atomic. The reference used a non-atomic Get-then-Put here,
    // so two concurrent invocations could both conclude they were first.
    const first = await claimInterruptionHandling({
        tenantId: ctx.acting.tenantId,
        accountId: ctx.accountId,
        region: ctx.region,
        clusterName: ctx.clusterName,
        serviceName: ctx.serviceName,
        taskArn,
        capacityType,
        observedAt: ctx.occurredAt,
    });

    // Always record the interruption for every tenant, even when we did not drain —
    // the timeline should show the reclaim regardless.
    for (const binding of ctx.bindings) {
        // Count it against the service AND get its row id. Both halves were missing: nothing
        // incremented interruptionCount, so the per-service column read 0 while the 24h card
        // counted the real events; and this was the only notify() in this file without a
        // spotServiceId, so interruptions never showed in a service's own timeline.
        const serviceId = await recordInterruption({
            tenantId: binding.tenantId,
            accountId: ctx.accountId,
            region: ctx.region,
            clusterName: ctx.clusterName,
            serviceName: ctx.serviceName,
        });

        await notify({
            tenantId: binding.tenantId,
            // null on the first ever sighting of a service — handleTaskStateChange creates the
            // row moments later. Unlinked is what every interruption did before this.
            spotServiceId: serviceId,
            accountId: ctx.accountId,
            region: ctx.region,
            clusterName: ctx.clusterName,
            serviceName: ctx.serviceName,
            eventType: 'interruption',
            severity: 'warning',
            alertType: 'interruption',
            sourceEventId: ctx.sourceEventId,
            taskArn,
            capacityProvider: ctx.envelope.detail?.capacityProviderName ?? null,
            stopCode: ctx.envelope.detail?.stopCode ?? null,
            stoppedReason: ctx.envelope.detail?.stoppedReason ?? null,
            message: `Spot task for ${ctx.serviceName} is being reclaimed; draining traffic.`,
            slackText: `:warning: Spot interruption: a task for *${ctx.serviceName}* (\`${ctx.accountId}\`, ${ctx.region}) is being reclaimed. Draining traffic from the load balancer.`,
            occurredAt: ctx.occurredAt,
        });
    }

    if (!first) {
        log.debug('Interruption already handled for this task — skipping pre-drain', { taskArn });
        return;
    }

    // Staleness gate. After an outage the 4h SQS backlog drains at once, and pre-draining
    // a task that died an hour ago is pointless — but the session/accounting rows above
    // are valid at any age, which is why this check sits HERE and not at the top.
    if (!isEventActionable(ctx.occurredAt.getTime(), Date.now(), SPOT_GUARD_CONFIG)) {
        log.info('Interruption event too old to act on — recorded but not drained', {
            taskArn,
            ageMs: ctx.ageMs,
        });
        return;
    }

    const clients = await createSpokeClients(ctx.acting, ctx.region);
    const described = await describeServiceState(clients.ecs, ctx.clusterName, ctx.serviceName);
    if (!described) return;

    const { drained, ip } = await preDrainTaskFromAlb(clients, {
        clusterArn: ctx.clusterArn,
        taskArn,
        service: described.raw,
    });

    // Bounded deregistration delay: the ALB default of 300s outlives the ~120s Spot
    // notice, so without this a draining target can hold connections past termination.
    if (described.state.hasLoadBalancers) {
        await enforceDeregistrationDelay(clients.elbv2, described.raw);
    }

    if (drained > 0) {
        for (const binding of ctx.bindings) {
            await writeEvent({
                tenantId: binding.tenantId,
                accountId: ctx.accountId,
                region: ctx.region,
                clusterName: ctx.clusterName,
                serviceName: ctx.serviceName,
                eventType: 'alb_predrain',
                severity: 'info',
                sourceEventId: ctx.sourceEventId ? `${ctx.sourceEventId}:predrain` : null,
                taskArn,
                message: `Pre-drained ${ip ?? 'task'} from ${drained} target group(s).`,
                occurredAt: new Date(),
                metadata: { targetGroups: drained, ip },
            });
        }
    }
}

// ── Task state change → sessions + capacity transitions ──────────────────────

async function handleTaskStateChange(ctx: EventContext): Promise<void> {
    const detail = ctx.envelope.detail ?? {};
    const taskArn = detail.taskArn;
    if (!taskArn) return;

    const capacityType: CapacityType = classifyCapacity(detail.capacityProviderName);
    const lastStatus = detail.lastStatus;

    /**
     * Live service state, fetched AT MOST ONCE per event and only if something needs it.
     *
     * Memoised rather than fetched per binding: several tenants can own the same AWS service, and
     * the answer is identical for all of them. Never throws — a failed read leaves the row exactly
     * as it was, which is the behaviour this path had before.
     */
    let live: LiveServiceState | null = null;
    let liveFetched = false;
    const liveState = async (): Promise<LiveServiceState | null> => {
        if (liveFetched) return live;
        liveFetched = true;
        try {
            const clients = await createSpokeClients(ctx.acting, ctx.region);
            const described = await describeServiceState(clients.ecs, ctx.clusterName, ctx.serviceName);
            live = described?.state ?? null;
        } catch (err) {
            log.warn('Could not read live service state on a task event — leaving counts as they are', {
                serviceName: ctx.serviceName,
                error: err instanceof Error ? err.message : String(err),
            });
            live = null;
        }
        return live;
    };

    if (lastStatus === 'RUNNING') {
        const startedAt = parseDate(detail.startedAt) ?? parseDate(detail.createdAt) ?? ctx.occurredAt;
        const cpuUnits = Number(detail.cpu);
        const memoryMiB = Number(detail.memory);

        for (const binding of ctx.bindings) {
            await openSession({
                tenantId: binding.tenantId,
                accountId: ctx.accountId,
                region: ctx.region,
                clusterName: ctx.clusterName,
                serviceName: ctx.serviceName,
                taskArn,
                capacityProvider: detail.capacityProviderName ?? null,
                capacityType,
                startedAt,
                cpuUnits: Number.isFinite(cpuUnits) && cpuUnits > 0 ? cpuUnits : null,
                memoryMiB: Number.isFinite(memoryMiB) && memoryMiB > 0 ? memoryMiB : null,
            });

            // Capacity transition detection, from the registry's previous state. This is
            // how a MANUAL human switch also gets surfaced — the check is indifferent to
            // who changed the capacity, which was deliberate in the reference.
            const existing = await findService({
                tenantId: binding.tenantId,
                accountId: ctx.accountId,
                region: ctx.region,
                clusterName: ctx.clusterName,
                serviceName: ctx.serviceName,
            });
            const previous: CapacityType | 'unknown' =
                existing?.capacityState === 'spot' || existing?.capacityState === 'on_demand'
                    ? existing.capacityState
                    : 'unknown';
            const transition = deriveCapacityTransition(previous, capacityType);

            // A task just reached RUNNING while our row still says the service has no tasks. That
            // is a contradiction, and it is the normal state after any scale-up: this path updates
            // capacityState from the event but has never known desiredCount, so the row stayed at 0
            // — and the console read "Stopped" for a service that had been running for minutes,
            // until the hourly re-observation caught up.
            //
            // Resolve it with ONE DescribeServices, gated on the contradiction so it fires once per
            // scale-up rather than on every task event. That gate is what keeps this path cheap:
            // this handler runs in-process precisely because it must not make an AWS call per event.
            // Refreshing observedStrategy at the same time is free, since we have the response.
            const looksStopped = (existing?.desiredCount ?? 0) === 0;
            if (looksStopped) live = await liveState();

            const serviceId = await upsertObservedService({
                tenantId: binding.tenantId,
                accountId: ctx.accountId,
                region: ctx.region,
                clusterName: ctx.clusterName,
                serviceName: ctx.serviceName,
                clusterArn: ctx.clusterArn,
                observedStrategy: live?.currentStrategy ?? existing?.observedStrategy ?? [],
                capacityState: capacityType,
                ...(live
                    ? {
                          desiredCount: live.desiredCount,
                          runningCount: live.runningCount,
                          serviceStatus: live.status,
                      }
                    : {}),
            });

            if (transition) {
                await notify({
                    tenantId: binding.tenantId,
                    spotServiceId: serviceId,
                    accountId: ctx.accountId,
                    region: ctx.region,
                    clusterName: ctx.clusterName,
                    serviceName: ctx.serviceName,
                    eventType: 'capacity_transition',
                    severity: transition === 'recovery' ? 'info' : 'warning',
                    // Distinct 600s windows per direction, matching the reference's
                    // RECOVERY#/FALLBACK# keys. Note this fires for MANUAL human switches
                    // too — the check is indifferent to who changed the capacity, which was
                    // deliberate in the reference and is worth keeping: an operator moving a
                    // service off Spot by hand is exactly what a team wants to hear about.
                    alertType: transition === 'recovery' ? 'recovery' : 'fallback',
                    sourceEventId: ctx.sourceEventId ? `${ctx.sourceEventId}:transition` : null,
                    fromCapacity: previous === 'unknown' ? null : previous,
                    toCapacity: capacityType,
                    message:
                        transition === 'recovery'
                            ? `${ctx.serviceName} is back on Spot capacity.`
                            : `${ctx.serviceName} moved from Spot to On-Demand capacity.`,
                    slackText:
                        transition === 'recovery'
                            ? `:white_check_mark: Recovery: *${ctx.serviceName}* (\`${ctx.accountId}\`, ${ctx.region}) is back on Spot capacity.`
                            : `:rotating_light: *${ctx.serviceName}* (\`${ctx.accountId}\`, ${ctx.region}) moved from Spot to On-Demand capacity.`,
                    occurredAt: ctx.occurredAt,
                });
            }
        }
        return;
    }

    if (lastStatus === 'STOPPED') {
        const stoppedAt = parseDate(detail.stoppedAt) ?? ctx.occurredAt;
        for (const binding of ctx.bindings) {
            await closeSession({
                tenantId: binding.tenantId,
                accountId: ctx.accountId,
                region: ctx.region,
                clusterName: ctx.clusterName,
                serviceName: ctx.serviceName,
                taskArn,
                capacityProvider: detail.capacityProviderName ?? null,
                capacityType,
                stoppedAt,
                stopCode: detail.stopCode ?? null,
                stoppedReason: detail.stoppedReason ?? null,
                interrupted: isSpotInterruption(detail),
            });
        }
    }
}

/** Exported for the unused-import linter and for direct testing. */
export const __testables = { isSpotInterruption, serviceNameFromGroup, clusterNameFromArn, regionFromArn, serviceNameFromResources };
