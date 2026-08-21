// workers/src/jobs/scaling-audit/services/platform-recorder.ts
//
// Called synchronously by the scheduler (asg-scheduler.ts / ecs-scheduler.ts) at
// the moment it mutates an ASG/ECS service, so the platform's OWN scaling
// actions are captured — the AWS activity-poll alone cannot see these. A direct
// ecs:UpdateService / autoscaling:UpdateAutoScalingGroup call is invisible to
// Describe*ScalingActivities (that API only reports activities Application Auto
// Scaling / Auto Scaling itself initiated), and a min/max change is a guardrail
// mutation the activity APIs never record at all — see ecs-scheduler.ts /
// asg-scheduler.ts.
//
// Non-fatal by construction: a failure to record the compliance row must never
// break the scheduled scaling action itself.
import { createLogger } from '../../../lib/logger.js';
import { insertEvents, isScalingAuditEnabledForAccount } from './db-writer.js';
import type { NormalizedScalingEvent, ScalingScope } from '../types.js';

const log = createLogger('scaling-audit-platform-recorder');

export interface RecordPlatformScalingEventInput {
    tenantId?: string;
    accountId: string;
    region: string;
    scope: ScalingScope;
    resourceId: string;
    asgName?: string;
    clusterName?: string;
    serviceName?: string;
    /** Deterministic and stable across retries of the SAME execution, e.g.
     *  `${executionId}-${resourceId}-${action}` — the writer's idempotent
     *  ON CONFLICT DO NOTHING relies on this being reproducible. */
    activityId: string;
    description: string;
    statusCode: 'Successful' | 'Failed';
    statusMessage?: string;
    desiredBefore?: number;
    desiredAfter?: number;
    minBefore?: number;
    maxBefore?: number;
    minAfter?: number;
    maxAfter?: number;
    /** Schedule id/name that drove this action. */
    initiatedBy?: string;
    /** The scheduler execution id, for cross-referencing scheduler audit_log rows. */
    correlationId?: string;
    rawPayload?: Record<string, unknown>;
}

/**
 * Record one platform-initiated scaling action into the same ScalingEvent table
 * the AWS-poll side writes to (source='platform'). These ARE known to be
 * schedule-driven by construction (the platform is the one causing them), so
 * scalingType is set directly rather than inferred via classifyCause() — there
 * is nothing to infer.
 */
export async function recordPlatformScalingEvent(input: RecordPlatformScalingEventInput): Promise<void> {
    if (!input.tenantId) return; // no tenant to scope this compliance row to

    try {
        // Same opt-in the AWS-poll side enforces via getScalingAuditEligibleAccounts —
        // this synchronous path has no eligible-accounts list in hand, so it asks
        // directly rather than silently recording for an account that switched
        // Scale Sentinel off.
        if (!(await isScalingAuditEnabledForAccount(input.tenantId, input.accountId))) return;

        const event: NormalizedScalingEvent = {
            tenantId: input.tenantId,
            accountId: input.accountId,
            region: input.region,
            scope: input.scope,
            source: 'platform',
            activityId: input.activityId,
            resourceId: input.resourceId,
            asgName: input.asgName,
            clusterName: input.clusterName,
            serviceName: input.serviceName,
            cause: input.description,
            description: input.description,
            statusCode: input.statusCode,
            statusMessage: input.statusMessage,
            startedAt: new Date(),
            inventoryMatched: false,
            scalingType: 'scheduled',
            scheduledActionName: input.initiatedBy,
            desiredBefore: input.desiredBefore,
            desiredAfter: input.desiredAfter,
            minBefore: input.minBefore,
            maxBefore: input.maxBefore,
            minAfter: input.minAfter,
            maxAfter: input.maxAfter,
            actor: 'system',
            actorType: 'system',
            initiatedBy: input.initiatedBy,
            correlationId: input.correlationId,
            rawPayload: input.rawPayload ?? {},
        };
        await insertEvents([event], `scheduler-${input.correlationId ?? 'unknown'}`);
    } catch (err) {
        log.warn('Failed to record platform scaling event — the scaling action itself is unaffected', {
            tenantId: input.tenantId,
            resourceId: input.resourceId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}
