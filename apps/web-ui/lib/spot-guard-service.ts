// web-ui/lib/spot-guard-service.ts
//
// Business logic for Fargate Spot Guard. Static-method class, data access via the repository
// factory only, every AWS mutation audit-logged — matching lib/right-sizing-service.ts.
import { getSpotGuardRepository, getAccountRepository } from '@/lib/db/repository-factory';
import { AuditService } from '@/lib/audit-service';
import { getBoss } from '@/lib/boss-client';
import {
    addSpotProvider,
    buildFallbackStrategy,
    buildSpotFirstStrategy,
    deriveCapacityState,
    hasSpotProvider,
    isSpotFirstState,
} from '@/lib/spot-guard/strategy';
import { clusterCapacityProviders, describeService, ecsClientFor, updateCapacityProvider } from '@/lib/spot-guard/ecs-client';
import type {
    EligibleFilters,
    EventFilters,
    ManagementState,
    ServiceFilters,
    SpotGuardService as SpotGuardServiceRow,
} from '@/lib/db/repositories/spot-guard/interface';

const RESTORE_QUEUE = 'spot-guard-restore-scan';

/** Thrown conditions the routes translate into specific HTTP statuses. */
export const SpotGuardErrors = {
    NOT_FOUND: 'NOT_FOUND',
    CONFIRMATION_MISMATCH: 'CONFIRMATION_MISMATCH',
    NO_SPOT_CAPACITY_PROVIDER: 'NO_SPOT_CAPACITY_PROVIDER',
    SERVICE_NOT_IN_AWS: 'SERVICE_NOT_IN_AWS',
    DEPLOYMENT_IN_PROGRESS: 'DEPLOYMENT_IN_PROGRESS',
    ACCOUNT_NOT_FOUND: 'ACCOUNT_NOT_FOUND',
    /**
     * The account's spotAutomationEnabled is false. ecs:UpdateService is granted to the
     * cross-account role unconditionally (it is shared with the Cost Scheduler), so nothing at
     * the IAM layer stops this call from succeeding — this check is the only thing that does.
     * Enabling Spot on such an account would move traffic onto interruptible capacity with no
     * automated restore behind it: the hourly restore scan, the inbound Spot-interruption event
     * handler, and the EventBridge forwarding rule in the customer's CFN stack are all scoped to
     * spotAutomationEnabled = true, so an interruption here would just never be noticed.
     */
    SPOT_AUTOMATION_DISABLED: 'SPOT_AUTOMATION_DISABLED',
} as const;

export interface EnableSpotInput {
    /** Must equal the target's serviceName — see the route's Zod schema for why. */
    confirmServiceName: string;
    spotWeight?: number;
    /** Relative weight for On-Demand. >0 gives a deliberate blend, e.g. 50/50 for prod. */
    onDemandWeight?: number;
    onDemandBase?: number;
}

export class SpotGuardService {
    // ── Reads ────────────────────────────────────────────────────────────────

    static getFacets(tenantId: string) {
        return getSpotGuardRepository().getFacets(tenantId);
    }

    static listServices(filters: ServiceFilters) {
        return getSpotGuardRepository().listServices(filters);
    }

    static listEvents(filters: EventFilters) {
        return getSpotGuardRepository().listEvents(filters);
    }

    static listEligibleServices(filters: EligibleFilters) {
        return getSpotGuardRepository().listEligibleServices(filters);
    }

    static getSummary(tenantId: string) {
        return getSpotGuardRepository().getSummary(tenantId);
    }

    static getHoursReport(tenantId: string, range: { from: Date; to: Date }) {
        return getSpotGuardRepository().getHoursReport(tenantId, range);
    }

    /**
     * Service detail plus its recent timeline.
     *
     * The event lookup is tolerated failing (`.catch`) so a timeline problem degrades one
     * panel rather than 500-ing the whole detail page — the same defensive shape
     * certificate/right-sizing detail views use.
     */
    static async getServiceDetail(id: string, tenantId: string) {
        const service = await getSpotGuardRepository().getService(id, tenantId);
        if (!service) throw new Error(SpotGuardErrors.NOT_FOUND);
        const events = await getSpotGuardRepository()
            .listEvents({ tenantId, spotServiceId: id, limit: 50 })
            .catch(() => ({ events: [], total: 0 }));
        return { service, events: events.events };
    }

    // ── Mutations ────────────────────────────────────────────────────────────

    /**
     * Put an ECS service onto Fargate Spot.
     *
     * A capability the reference implementation deliberately LACKED — it required a manual
     * `aws ecs update-service` and only ever managed services somebody else had already put
     * on Spot. Because this newly moves production traffic onto interruptible capacity, it is
     * gated three ways: RBAC (`update` on SpotGuard, which maps to Schedules), a typed
     * confirmation echoing the service name, and a live pre-flight against AWS.
     *
     * Accepts either an existing registry id or an inventory-derived target, so the first
     * opt-in works straight from the eligible-services list.
     */
    static async enableSpot(
        tenantId: string,
        target:
            | { kind: 'registry'; id: string }
            | { kind: 'discovered'; accountId: string; region: string; clusterName: string; serviceName: string },
        userId: string,
        input: EnableSpotInput,
    ): Promise<SpotGuardServiceRow> {
        const repo = getSpotGuardRepository();

        const resolved =
            target.kind === 'registry'
                ? await repo.getService(target.id, tenantId)
                : await repo.findServiceByTarget(tenantId, target);

        const identity =
            resolved ??
            (target.kind === 'discovered'
                ? {
                      accountId: target.accountId,
                      region: target.region,
                      clusterName: target.clusterName,
                      serviceName: target.serviceName,
                  }
                : null);
        if (!identity) throw new Error(SpotGuardErrors.NOT_FOUND);

        // Confirmation is checked BEFORE any AWS call, so a mismatched request cannot even
        // cause a describe against the customer's account.
        if (input.confirmServiceName !== identity.serviceName) {
            throw new Error(SpotGuardErrors.CONFIRMATION_MISMATCH);
        }

        const account = await SpotGuardService.requireAccount(tenantId, identity.accountId);

        // ecs:UpdateService is granted to the cross-account role unconditionally — it is shared
        // with the Cost Scheduler's start/stop automation, so it cannot be conditioned on this
        // flag at the IAM layer without breaking scheduling for every account that never opted
        // into Spot Guard. This is therefore the ONLY thing stopping an enable (a fresh opt-in,
        // or a capacity change on an already-managed service — both reach this method) on an
        // account where automation is deliberately off. Checked before ecsClientFor, which
        // itself makes a real sts:AssumeRole call, so a blocked account never touches AWS at all.
        if (!account.spotAutomationEnabled) {
            throw new Error(SpotGuardErrors.SPOT_AUTOMATION_DISABLED);
        }

        const ecs = await ecsClientFor(
            { accountId: account.accountId, roleArn: account.roleArn, externalId: account.externalId },
            identity.region,
        );

        const live = await describeService(ecs, identity.clusterName, identity.serviceName);
        if (!live) throw new Error(SpotGuardErrors.SERVICE_NOT_IN_AWS);
        // Never stack a capacity change on an in-flight rollout — this is also where a
        // collision with the Cost Scheduler would surface.
        if (live.deploymentInProgress) throw new Error(SpotGuardErrors.DEPLOYMENT_IN_PROGRESS);

        let nextStrategy;
        if (hasSpotProvider(live.strategy)) {
            // onDemandWeight defaults to 0 here for the same reason addSpotProvider forces it:
            // enable must not inherit a weight the service happened to have. The dialog always
            // sends a value, so this default only covers direct API callers.
            nextStrategy = buildSpotFirstStrategy(live.strategy, { ...input, onDemandWeight: input.onDemandWeight ?? 0 });
        } else {
            // No Spot provider in the strategy: the cluster must actually offer one, or
            // UpdateService rejects it with an opaque error. Surface an actionable 409 with
            // the cluster's real providers instead.
            const providers = await clusterCapacityProviders(ecs, identity.clusterName);
            const spotProvider = providers.find((p) => /spot/i.test(p));
            if (!spotProvider) {
                throw new Error(
                    `${SpotGuardErrors.NO_SPOT_CAPACITY_PROVIDER}: cluster ${identity.clusterName} offers [${providers.join(', ') || 'none'}]`,
                );
            }
            nextStrategy = addSpotProvider(live.strategy, spotProvider, input);
        }

        // Belt-and-braces: never issue an "enable" that would place nothing on Spot. That
        // would bounce every task, count as success, and leave the service fully On-Demand.
        if (!isSpotFirstState(nextStrategy)) throw new Error(SpotGuardErrors.NO_SPOT_CAPACITY_PROVIDER);

        await updateCapacityProvider(ecs, identity.clusterName, identity.serviceName, nextStrategy);

        const saved = await repo.upsertService(tenantId, {
            accountId: identity.accountId,
            region: identity.region,
            clusterName: identity.clusterName,
            serviceName: identity.serviceName,
            clusterArn: live.raw.clusterArn ?? null,
            serviceArn: live.raw.serviceArn ?? null,
            // The applied strategy becomes the restore baseline.
            desiredStrategy: nextStrategy,
            observedStrategy: nextStrategy,
            capacityState: deriveCapacityState(nextStrategy),
            managementState: 'managed',
            desiredCount: live.desiredCount,
            runningCount: live.runningCount,
            enabledBy: userId,
            actor: userId,
            // The strategy was just applied live via UpdateService, so any restore the hourly
            // job had queued is already done, and any backoff is moot — a human just acted
            // directly.
            resetRestoreState: true,
        });

        await repo.recordEvent(tenantId, {
            spotServiceId: saved.id,
            accountId: identity.accountId,
            region: identity.region,
            clusterName: identity.clusterName,
            serviceName: identity.serviceName,
            eventType: 'spot_enabled',
            severity: 'info',
            strategyBefore: live.strategy,
            strategyAfter: nextStrategy,
            message: `${identity.serviceName} enabled on Fargate Spot.`,
            actor: userId,
        });

        await AuditService.logUserAction({
            eventType: 'spot_guard.spot.enabled',
            action: 'Enabled Fargate Spot on ECS service',
            resourceType: 'SpotGuard',
            resourceId: `${identity.accountId}/${identity.clusterName}/${identity.serviceName}`,
            resourceName: identity.serviceName,
            user: userId,
            userType: 'user',
            status: 'success',
            // High: this moves production traffic onto interruptible capacity.
            severity: 'high',
            details: `Enabled Fargate Spot on ${identity.serviceName} (${identity.clusterName}, ${identity.region}).`,
            tenantId,
            dataClassification: 'infrastructure',
            metadata: { before: live.strategy, after: nextStrategy, accountId: identity.accountId },
        });

        return saved;
    }

    /**
     * Take a service OFF Spot and stop automating it.
     *
     * Uses the fallback strategy shape rather than deleting the Spot provider, so the
     * service's history stays legible and a later re-enable is one step. managementState
     * becomes 'opted_out', which the hourly job treats as "never restore" — distinct from
     * 'unmanaged' (stop automating, leave AWS alone).
     */
    static async disableSpot(
        tenantId: string,
        id: string,
        userId: string,
        input: { confirmServiceName: string },
    ): Promise<SpotGuardServiceRow> {
        const repo = getSpotGuardRepository();
        const service = await repo.getService(id, tenantId);
        if (!service) throw new Error(SpotGuardErrors.NOT_FOUND);
        if (input.confirmServiceName !== service.serviceName) {
            throw new Error(SpotGuardErrors.CONFIRMATION_MISMATCH);
        }

        const account = await SpotGuardService.requireAccount(tenantId, service.accountId);
        const ecs = await ecsClientFor(
            { accountId: account.accountId, roleArn: account.roleArn, externalId: account.externalId },
            service.region,
        );
        const live = await describeService(ecs, service.clusterName, service.serviceName);
        if (!live) throw new Error(SpotGuardErrors.SERVICE_NOT_IN_AWS);
        if (live.deploymentInProgress) throw new Error(SpotGuardErrors.DEPLOYMENT_IN_PROGRESS);

        const nextStrategy = buildFallbackStrategy(live.strategy);
        await updateCapacityProvider(ecs, service.clusterName, service.serviceName, nextStrategy);

        const saved = await repo.upsertService(tenantId, {
            accountId: service.accountId,
            region: service.region,
            clusterName: service.clusterName,
            serviceName: service.serviceName,
            desiredStrategy: service.desiredStrategy,
            observedStrategy: nextStrategy,
            capacityState: deriveCapacityState(nextStrategy),
            managementState: 'opted_out',
            desiredCount: live.desiredCount,
            runningCount: live.runningCount,
            disabledBy: userId,
            actor: userId,
            // managementState is now 'opted_out', which the hourly job already treats as
            // "never restore" — but leaving a stale restorePending=true made the detail page
            // claim a restore was queued for a service that will never be restored while it
            // stays opted out.
            resetRestoreState: true,
        });

        await repo.recordEvent(tenantId, {
            spotServiceId: saved.id,
            accountId: service.accountId,
            region: service.region,
            clusterName: service.clusterName,
            serviceName: service.serviceName,
            eventType: 'spot_disabled',
            severity: 'warning',
            strategyBefore: live.strategy,
            strategyAfter: nextStrategy,
            message: `${service.serviceName} moved to On-Demand and opted out of Spot automation.`,
            actor: userId,
        });

        await AuditService.logUserAction({
            eventType: 'spot_guard.spot.disabled',
            action: 'Disabled Fargate Spot on ECS service',
            resourceType: 'SpotGuard',
            resourceId: `${service.accountId}/${service.clusterName}/${service.serviceName}`,
            resourceName: service.serviceName,
            user: userId,
            userType: 'user',
            status: 'success',
            severity: 'high',
            details: `Disabled Fargate Spot on ${service.serviceName} (${service.clusterName}, ${service.region}).`,
            tenantId,
            dataClassification: 'infrastructure',
            metadata: { before: live.strategy, after: nextStrategy },
        });

        return saved;
    }

    /**
     * Stop automating a service WITHOUT touching AWS.
     *
     * The non-mutating off-ramp, offered alongside disableSpot because they answer different
     * questions: "get me off Spot" vs "stop automating, I'll manage it myself".
     */
    static async setManagementState(
        tenantId: string,
        id: string,
        state: ManagementState,
        userId: string,
    ): Promise<SpotGuardServiceRow> {
        const repo = getSpotGuardRepository();
        const saved = await repo.setManagementState(id, tenantId, state, userId);

        await repo.recordEvent(tenantId, {
            spotServiceId: saved.id,
            accountId: saved.accountId,
            region: saved.region,
            clusterName: saved.clusterName,
            serviceName: saved.serviceName,
            eventType: 'unmanaged',
            severity: 'info',
            message: `${saved.serviceName} management state set to ${state} (AWS unchanged).`,
            actor: userId,
        });

        await AuditService.logUserAction({
            eventType: 'spot_guard.management.changed',
            action: 'Changed Spot Guard management state',
            resourceType: 'SpotGuard',
            resourceId: saved.id,
            resourceName: saved.serviceName,
            user: userId,
            userType: 'user',
            status: 'success',
            // Medium, not high: no AWS resource is modified by this path.
            severity: 'medium',
            details: `Set ${saved.serviceName} management state to ${state}. No AWS change.`,
            tenantId,
            dataClassification: 'infrastructure',
            metadata: { managementState: state },
        });

        return saved;
    }

    /**
     * Queue an immediate restore pass for this tenant.
     *
     * `force: true` bypasses ONLY the backoff — every safety gate (scheduler protection,
     * governance, in-flight deployment, the daily restore cap) still applies in the worker.
     * Returns null when a scan is already queued or active for the tenant, which the route
     * reports as 200 rather than 202.
     */
    static async triggerRestore(
        tenantId: string,
        userId: string,
        serviceIds?: string[],
    ): Promise<{ jobId: string | null }> {
        const boss = await getBoss();
        const jobId = await boss.send(
            RESTORE_QUEUE,
            { tenantId, trigger: 'manual', serviceIds, force: true },
            { singletonKey: `tenant:${tenantId}`, retryLimit: 0 },
        );

        await AuditService.logUserAction({
            eventType: 'spot_guard.restore.triggered',
            action: 'Triggered Spot Guard restore',
            resourceType: 'SpotGuard',
            resourceId: serviceIds?.join(',') ?? `tenant:${tenantId}`,
            resourceName: 'Spot Guard restore',
            user: userId,
            userType: 'user',
            status: 'success',
            severity: 'medium',
            details: jobId
                ? `Queued a Spot restore pass${serviceIds?.length ? ` for ${serviceIds.length} service(s)` : ''}.`
                : 'A restore pass was already queued or running; no new job created.',
            tenantId,
            dataClassification: 'infrastructure',
            metadata: { jobId, serviceIds, forced: true },
        });

        return { jobId };
    }

    // ── Internals ────────────────────────────────────────────────────────────

    /** The tenant's account row, needed for roleArn/externalId. */
    private static async requireAccount(tenantId: string, accountId: string) {
        const account = await getAccountRepository().getAccount(accountId, tenantId);
        if (!account?.roleArn) throw new Error(SpotGuardErrors.ACCOUNT_NOT_FOUND);
        return {
            accountId,
            roleArn: account.roleArn,
            externalId: account.externalId ?? null,
            spotAutomationEnabled: account.spotAutomationEnabled ?? false,
        };
    }
}
