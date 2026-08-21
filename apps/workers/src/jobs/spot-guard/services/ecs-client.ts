// workers/src/jobs/spot-guard/services/ecs-client.ts
//
// The only Spot Guard module that mutates AWS (SG-007). Everything here runs under a
// role assumed into the customer's account — never the hub's own credentials.
//
// Reuses the shared assumeRole from jobs/discovery/services/sts-service.ts rather than
// hand-rolling another STS client. The repo already has three near-duplicate
// implementations of that (discovery, scheduler, certificate-expiry-monitor) and adding
// a fourth would be the wrong kind of consistency.
import {
    ECSClient,
    DescribeServicesCommand,
    UpdateServiceCommand,
    DescribeTasksCommand,
    DescribeTaskDefinitionCommand,
    type Service,
    type Task,
} from '@aws-sdk/client-ecs';
import {
    ElasticLoadBalancingV2Client,
    DeregisterTargetsCommand,
    ModifyTargetGroupAttributesCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { assumeRole } from '../../discovery/services/sts-service.js';
import { createLogger } from '../../../lib/logger.js';
import { SPOT_GUARD_CONFIG } from '../config.js';
import type { CapacityProviderStrategyItem, LiveServiceState, SpokeBinding } from '../types.js';

const log = createLogger('spot-guard-ecs');

export interface SpokeClients {
    ecs: ECSClient;
    elbv2: ElasticLoadBalancingV2Client;
}

/**
 * Assume the customer's NucleusAccess role and build both clients from the temporary
 * credentials. Returned together because the interruption path needs ECS to find the
 * task's ENI and ELBv2 to drain it, and splitting them would mean two AssumeRole calls.
 */
export async function createSpokeClients(binding: SpokeBinding, region: string): Promise<SpokeClients> {
    // Pass an explicit session name. Without it the shared helper defaults to
    // "NucleusDiscovery-<account>-<region>", which mis-attributes every Spot Guard
    // mutation to the read-only discovery job in CloudTrail — verified against a real
    // fallback that showed up as NucleusDiscovery-688849551607-ap-south-1. This path
    // calls UpdateService with forceNewDeployment and drains ALB targets, so the audit
    // trail must name Spot Guard. Matches the web-ui side's NucleusSpotGuard-<account>.
    const assumed = await assumeRole(
        binding.roleArn,
        binding.accountId,
        region,
        binding.externalId ?? undefined,
        `NucleusSpotGuard-${binding.accountId}`,
    );
    const credentials = assumed.credentials;
    return {
        ecs: new ECSClient({ region, credentials }),
        elbv2: new ElasticLoadBalancingV2Client({ region, credentials }),
    };
}

/**
 * Read the live state the decision engine needs.
 *
 * deploymentInProgress is derived from deployments[].rolloutState and is the guard
 * against colliding with Nucleus's OWN Cost Scheduler, which calls UpdateService on the
 * same services. It costs nothing — the field is already in this response.
 */
/**
 * Batched read for the re-observation pass: up to 10 services per DescribeServices call, which is
 * the AWS maximum. Keyed by service NAME in the returned map.
 *
 * Separate from describeServiceState rather than replacing it: that one is called on a single
 * service in the mutating paths, where the extra `raw` Service (needed for ALB pre-drain and target
 * group resolution) matters. This one only needs the derived state, for many services at once.
 *
 * Services that no longer exist come back in `failures` and are simply absent from the map —
 * deletion between our registry write and this read is a normal outcome, not an error.
 */
export async function describeServicesBatch(
    ecs: ECSClient,
    clusterName: string,
    serviceNames: string[],
): Promise<Map<string, LiveServiceState>> {
    const out = new Map<string, LiveServiceState>();
    for (let i = 0; i < serviceNames.length; i += 10) {
        const chunk = serviceNames.slice(i, i + 10);
        const res = await ecs.send(new DescribeServicesCommand({ cluster: clusterName, services: chunk }));
        for (const svc of res.services ?? []) {
            if (!svc.serviceName) continue;
            out.set(svc.serviceName, {
                currentStrategy: (svc.capacityProviderStrategy ?? []).map((cp) => ({
                    capacityProvider: cp.capacityProvider ?? '',
                    weight: cp.weight ?? 0,
                    base: cp.base ?? 0,
                })),
                desiredCount: svc.desiredCount ?? 0,
                runningCount: svc.runningCount ?? 0,
                status: svc.status ?? 'UNKNOWN',
                hasLoadBalancers: (svc.loadBalancers?.length ?? 0) > 0,
                deploymentInProgress: (svc.deployments ?? []).some((d) => d.rolloutState === 'IN_PROGRESS'),
            });
        }
    }
    return out;
}

export async function describeServiceState(
    ecs: ECSClient,
    clusterName: string,
    serviceName: string,
): Promise<{ raw: Service; state: LiveServiceState } | null> {
    const res = await ecs.send(new DescribeServicesCommand({ cluster: clusterName, services: [serviceName] }));
    const svc = res.services?.[0];
    // A missing service is a normal outcome — it may have been deleted between the
    // event being emitted and us reacting. The reference logged and continued here too.
    if (!svc) return null;

    const currentStrategy: CapacityProviderStrategyItem[] = (svc.capacityProviderStrategy ?? []).map((cp) => ({
        capacityProvider: cp.capacityProvider ?? '',
        weight: cp.weight ?? 0,
        base: cp.base ?? 0,
    }));

    return {
        raw: svc,
        state: {
            currentStrategy,
            desiredCount: svc.desiredCount ?? 0,
            runningCount: svc.runningCount ?? 0,
            status: svc.status ?? 'UNKNOWN',
            hasLoadBalancers: (svc.loadBalancers?.length ?? 0) > 0,
            deploymentInProgress: (svc.deployments ?? []).some((d) => d.rolloutState === 'IN_PROGRESS'),
        },
    };
}

/**
 * Apply a capacity provider strategy.
 *
 * forceNewDeployment is required: without it ECS applies the new strategy only to tasks
 * placed from now on, so a service already fully placed on unavailable Spot capacity
 * would never actually move. It is also why every caller must pass through the engine's
 * guards first — this bounces every task in the service.
 */
export async function updateCapacityProvider(
    ecs: ECSClient,
    clusterName: string,
    serviceName: string,
    strategy: CapacityProviderStrategyItem[],
): Promise<void> {
    await ecs.send(
        new UpdateServiceCommand({
            cluster: clusterName,
            service: serviceName,
            capacityProviderStrategy: strategy.map((cp) => ({
                capacityProvider: cp.capacityProvider,
                weight: cp.weight ?? 0,
                base: cp.base ?? 0,
            })),
            forceNewDeployment: true,
        }),
    );
    log.info('Capacity provider strategy updated', {
        clusterName,
        serviceName,
        strategy: strategy.map((cp) => `${cp.capacityProvider}:w${cp.weight ?? 0}:b${cp.base ?? 0}`).join(','),
    });
}

// ── ALB pre-drain ─────────────────────────────────────────────────────────────

/** The task's private IPv4 from its awsvpc ENI attachment, or null. */
export function extractTaskPrivateIp(task: Task): string | null {
    for (const attachment of task.attachments ?? []) {
        if (attachment.type !== 'ElasticNetworkInterface') continue;
        for (const detail of attachment.details ?? []) {
            if (detail.name === 'privateIPv4Address' && detail.value) return detail.value;
        }
    }
    return null;
}

/**
 * The container port the load balancer targets.
 *
 * Prefers the service's own loadBalancers[].containerPort, which is authoritative. The
 * reference instead walked the task definition looking for the first essential
 * container's first TCP portMapping and then matched it back against the service — more
 * steps and more ways to pick the wrong port on a multi-container task.
 */
export function resolveTargetGroups(svc: Service): { targetGroupArn: string; containerPort: number }[] {
    return (svc.loadBalancers ?? [])
        .filter((lb) => lb.targetGroupArn && typeof lb.containerPort === 'number')
        .map((lb) => ({ targetGroupArn: lb.targetGroupArn!, containerPort: lb.containerPort! }));
}

/**
 * Deregister a dying Spot task from its ALB target group(s) ahead of ECS doing it.
 *
 * This is the ONLY mitigation that happens before the task dies, and it is the reason
 * users do not see 5xx during the ~2 minute Spot reclaim window. ECS does drain the
 * target natively when the task enters DEACTIVATING, so this is a speed-up rather than
 * the only line of defence — which is exactly why every failure below is tolerated
 * instead of thrown.
 *
 * IP targets, not instance targets: Fargate tasks use awsvpc networking.
 *
 * Returns how many target groups were successfully drained.
 */
export async function preDrainTaskFromAlb(
    clients: SpokeClients,
    input: { clusterArn: string; taskArn: string; service: Service },
): Promise<{ drained: number; ip: string | null }> {
    const described = await clients.ecs.send(
        new DescribeTasksCommand({ cluster: input.clusterArn, tasks: [input.taskArn] }),
    );
    const task = described.tasks?.[0];
    if (!task) {
        log.warn('Interrupted task not found — nothing to pre-drain', { taskArn: input.taskArn });
        return { drained: 0, ip: null };
    }

    const ip = extractTaskPrivateIp(task);
    if (!ip) {
        // Non-awsvpc or the ENI is already detached. ECS's own draining still applies.
        log.warn('Could not resolve task ENI IP — skipping pre-drain', { taskArn: input.taskArn });
        return { drained: 0, ip: null };
    }

    const targets = resolveTargetGroups(input.service);
    if (targets.length === 0) return { drained: 0, ip };

    let drained = 0;
    for (const { targetGroupArn, containerPort } of targets) {
        try {
            await clients.elbv2.send(
                new DeregisterTargetsCommand({
                    TargetGroupArn: targetGroupArn,
                    Targets: [{ Id: ip, Port: containerPort }],
                }),
            );
            drained += 1;
        } catch (err) {
            // Best effort by design: the task is dying either way and ECS will drain it.
            // Failing the job here would retry a now-pointless deregistration.
            log.warn('ALB pre-drain failed for one target group', {
                targetGroupArn,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    return { drained, ip };
}

/**
 * Enforce a bounded deregistration delay on the service's target groups.
 *
 * Write-only "blind enforcement", ported deliberately from the reference: it calls
 * Modify WITHOUT a preceding Describe, precisely so it still works in spoke accounts
 * whose role lacks DescribeTargetGroupAttributes. Every failure is swallowed — this is
 * a nice-to-have that must never fail a remediation.
 *
 * Why it matters: the default deregistration delay is 300s, which is longer than the
 * ~120s Spot notice, so without this a draining target can outlive its task and hold
 * connections open past termination.
 */
export async function enforceDeregistrationDelay(
    elbv2: ElasticLoadBalancingV2Client,
    svc: Service,
): Promise<void> {
    for (const { targetGroupArn } of resolveTargetGroups(svc)) {
        try {
            await elbv2.send(
                new ModifyTargetGroupAttributesCommand({
                    TargetGroupArn: targetGroupArn,
                    Attributes: [
                        {
                            Key: 'deregistration_delay.timeout_seconds',
                            Value: String(SPOT_GUARD_CONFIG.albDeregistrationDelaySeconds),
                        },
                    ],
                }),
            );
        } catch (err) {
            log.warn('Could not enforce ALB deregistration delay', {
                targetGroupArn,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
}

/** Task size for the savings estimate. ECS reports these as strings. */
export async function resolveTaskSize(
    ecs: ECSClient,
    task: Task,
): Promise<{ cpuUnits: number | null; memoryMiB: number | null }> {
    const parse = (v?: string | null) => {
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? n : null;
    };
    // Task-level overrides win when present; otherwise fall back to the definition.
    const cpu = parse(task.cpu);
    const mem = parse(task.memory);
    if (cpu && mem) return { cpuUnits: cpu, memoryMiB: mem };

    if (!task.taskDefinitionArn) return { cpuUnits: cpu, memoryMiB: mem };
    try {
        const res = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: task.taskDefinitionArn }));
        return {
            cpuUnits: cpu ?? parse(res.taskDefinition?.cpu),
            memoryMiB: mem ?? parse(res.taskDefinition?.memory),
        };
    } catch {
        // Purely for a cost estimate — never worth failing the event for.
        return { cpuUnits: cpu, memoryMiB: mem };
    }
}
