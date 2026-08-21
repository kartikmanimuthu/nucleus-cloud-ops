// workers/src/jobs/scaling-audit/services/normalize.ts
//
// Turns a RawScalingActivity (straight off the AWS SDK) into a fully classified
// NormalizedScalingEvent, ready for db-writer to insert. Isolated from the AWS
// clients so it stays trivially unit-testable if needed, and so the "not scaled"
// override and inventory-match lookup live in exactly one place.
import { createHash } from 'node:crypto';
import { classifyCause, applyNotScaledOverride } from './cause-classifier.js';
import type { RawScalingActivity, NormalizedScalingEvent, ScalingScope, ScalingSource } from '../types.js';

export function causeFingerprint(resourceId: string, cause: string): string {
    return createHash('sha256').update(`${resourceId}|${cause}`).digest('hex');
}

/** arn:aws:ecs:<region>:<account>:service/<cluster>/<service> — long ARN format. */
const ECS_SERVICE_ARN = /^arn:[^:]*:ecs:[^:]*:[^:]*:(service\/.+)$/;

/**
 * Every identity the same ECS service can legitimately be recorded under, so a
 * resourceId from one subsystem can be matched against a resourceId from another.
 *
 * The two subsystems disagree on format, which is why this exists:
 *   - discovery/inventory stores the **service ARN**
 *     ("arn:aws:ecs:ap-south-1:1234:service/my-cluster/my-svc") because
 *     extractResourceIdentifiers() checks 'serviceArn' before 'serviceName'
 *     (discovery/services/scanner.ts idKeys)
 *   - Application Auto Scaling reports the **ResourceId**
 *     ("service/my-cluster/my-svc")
 *
 * The AAS form is an exact suffix of the ARN, so neither side is wrong — they
 * simply never compare equal, which made inventoryMatched false for every ECS
 * row regardless of whether the service existed. Verified against a live
 * ap-south-1 service on 2026-08-05.
 *
 * Also emits the bare service name to stay correct if an inventory row was
 * written under the legacy short ARN format (no cluster segment) or by a scanner
 * path that recorded 'serviceName'.
 */
export function inventoryIdentityKeys(resourceId: string): string[] {
    const keys = [resourceId];
    const arnMatch = resourceId.match(ECS_SERVICE_ARN);
    if (arnMatch) {
        keys.push(arnMatch[1]);
    }
    // Last path segment: the service name for both ARN and AAS forms. Harmless
    // for ASG rows, whose resourceId is already a bare group name.
    const lastSegment = resourceId.split('/').pop();
    if (lastSegment && lastSegment !== resourceId) {
        keys.push(lastSegment);
    }
    return keys;
}

export interface NormalizeContext {
    tenantId: string;
    accountId: string;
    region: string;
    scope: ScalingScope;
    source: ScalingSource;
    /** resourceIds present in current inventory for this scope — drives inventoryMatched. */
    inventoryResourceIds: Set<string>;
    actor?: string;
    actorType?: 'system' | 'user' | 'unattributed_out_of_band';
    initiatedBy?: string;
    correlationId?: string;
}

export function normalizeActivity(raw: RawScalingActivity, ctx: NormalizeContext): NormalizedScalingEvent {
    const notScaledList = Array.isArray(raw.notScaledReasons) ? (raw.notScaledReasons as Array<{ Code?: string }>) : [];
    const parsed = classifyCause(raw.cause, raw.description);
    // A source may pre-classify when IT is authoritative and the cause text is
    // not: CloudTrail's userIdentity proves a human principal made a direct API
    // call, so 'manual' there is evidence rather than the guess the classifier is
    // deliberately forbidden to make (it returns 'unparsed' instead).
    const sourceClassified = raw.scalingTypeOverride ? { ...parsed, scalingType: raw.scalingTypeOverride } : parsed;
    const classified = applyNotScaledOverride(sourceClassified, notScaledList.length > 0);

    return {
        ...raw,
        ...classified,
        scope: ctx.scope,
        source: ctx.source,
        tenantId: ctx.tenantId,
        accountId: ctx.accountId,
        region: ctx.region,
        // Try the activity's own resourceId first, then the bare service name —
        // the inventory set is pre-expanded to every equivalent identity by
        // inventoryIdentityKeys(), so either side may carry the ARN or the
        // Application Auto Scaling form.
        inventoryMatched:
            ctx.inventoryResourceIds.has(raw.resourceId) ||
            (!!raw.serviceName && ctx.inventoryResourceIds.has(raw.serviceName)),
        notScaledCode: notScaledList[0]?.Code,
        // Per-event attribution wins over the per-scan context. Only CloudTrail
        // knows the principal for an individual activity; the activity APIs report
        // a trigger, not a caller, so for them attribution comes from ctx.
        actor: raw.actor ?? ctx.actor ?? 'system',
        actorType: raw.actorType ?? ctx.actorType ?? 'system',
        initiatedBy: ctx.initiatedBy,
        correlationId: ctx.correlationId,
        // 'activity' when the Cause/Description text itself named the prior
        // value. Left undefined (not 'cloudwatch') when it didn't — index.ts's
        // enrichment step fills that in only if CloudWatch actually has it.
        desiredBeforeSource: classified.desiredBefore != null ? 'activity' : undefined,
    };
}
