// workers/src/jobs/scaling-audit/services/cloudtrail-client.ts
//
// CloudTrail capture of OUT-OF-BAND capacity changes (SA-002) — the changes the
// activity APIs structurally cannot see.
//
// Why this exists: application-autoscaling:DescribeScalingActivities only returns
// activities Application Auto Scaling ITSELF initiated. A direct
// `ecs:UpdateService --desired-count N` from the console, CLI, or a deploy
// pipeline never passes through it and leaves no trace. Verified live in
// ap-south-1 on 2026-08-05: a service created with desiredCount=1 at 10:34
// produced no AAS activity at all. ASG is different — it records every capacity
// change regardless of origin — but names only "a user request", never the
// principal. CloudTrail is the only source for either fact.
//
// Reads CloudTrail EVENT HISTORY, which is enabled by default in every region,
// covers ~90 days of management events, requires no trail, and costs nothing
// (LookupEvents has no per-request charge). That is why this is a poll and not an
// EventBridge rule: a pull with a watermark can attest which window was covered,
// and needs no CloudFormation redeploy in customer accounts.
import {
    CloudTrailClient,
    LookupEventsCommand,
    LookupAttributeKey,
    type Event as CloudTrailLookupEvent,
} from '@aws-sdk/client-cloudtrail';
import type { AssumedCredentials } from '../../discovery/types.js';
import type { PollOutcome, RawScalingActivity, ScalingScope } from '../types.js';
import { SCALING_AUDIT_CONFIG } from '../config.js';
import { withCloudTrailRetry } from './cloudtrail-retry.js';

/**
 * API calls that change capacity, and the scope each maps onto. Deliberately
 * narrow: this source exists to close the out-of-band gap, not to mirror every
 * ECS/ASG mutation into the compliance record.
 */
const WATCHED_EVENTS: Array<{ eventName: string; scope: ScalingScope }> = [
    { eventName: 'UpdateService', scope: 'ecs' },
    { eventName: 'SetDesiredCapacity', scope: 'asg' },
    { eventName: 'UpdateAutoScalingGroup', scope: 'asg' },
];

/** CloudTrail Event history retains ~90 days; never ask for more. */
const CLOUDTRAIL_RETENTION_DAYS = 90;

interface ParsedCloudTrailEvent {
    eventID?: string;
    eventName?: string;
    eventTime?: string;
    errorCode?: string;
    errorMessage?: string;
    sourceIPAddress?: string;
    userIdentity?: {
        type?: string;
        arn?: string;
        userName?: string;
        principalId?: string;
        invokedBy?: string;
        sessionContext?: { sessionIssuer?: { arn?: string; userName?: string } };
    };
    requestParameters?: Record<string, unknown>;
}

/**
 * Keep only changes made by a HUMAN principal.
 *
 * Automated scaling also appears in CloudTrail, but attributed to an AWS service
 * (`AWSService`, or `invokedBy: application-autoscaling.amazonaws.com`). Those
 * add nothing the activity APIs don't already record with a richer cause, and
 * ingesting them would duplicate every policy-driven scale. Filtering here is
 * what keeps CloudTrail complementary rather than redundant.
 */
export function isHumanPrincipal(identity: ParsedCloudTrailEvent['userIdentity']): boolean {
    if (!identity) return false;
    if (identity.invokedBy) return false; // called on behalf of an AWS service
    return ['IAMUser', 'AssumedRole', 'FederatedUser', 'Root'].includes(identity.type ?? '');
}

/**
 * True when the caller is THIS PLATFORM acting through its own cross-account role.
 *
 * Nucleus's schedulers scale customer resources by assuming the customer's
 * NucleusAccess role. To CloudTrail that is an AssumedRole with no invokedBy —
 * indistinguishable from a human by the filter above. Measured live on
 * 2026-08-05: without this check a single sbx account produced 1010 such rows
 * against 19 genuinely human ones, every one of them mislabelled
 * scalingType='manual' / actorType='user'. In a compliance record that is worse
 * than the volume: it asserts a person made a change the platform's own
 * scheduler made.
 *
 * Those changes belong to source='platform', written synchronously at mutation
 * time with the real actor and originating schedule — not to CloudTrail.
 *
 * Matched against the account's CONFIGURED roleArn rather than a name pattern,
 * because the role name is a customer-overridable CloudFormation parameter
 * (cf-template-generator.ts defaults it to NucleusAccess-<hubAccountId>, but the
 * customer may rename it). The configured ARN is exact and always correct.
 */
export function isPlatformPrincipal(identity: ParsedCloudTrailEvent['userIdentity'], platformRoleArn?: string): boolean {
    if (!identity || !platformRoleArn) return false;

    // Preferred: the session issuer IS the assumed role's ARN, comparable directly.
    const issuerArn = identity.sessionContext?.sessionIssuer?.arn;
    if (issuerArn && issuerArn === platformRoleArn) return true;

    // Fallback: compare role names out of
    // arn:aws:sts::<acct>:assumed-role/<ROLE>/<SESSION> vs
    // arn:aws:iam::<acct>:role/<ROLE>.
    const platformRoleName = platformRoleArn.split('/').pop();
    const assumedMatch = identity.arn?.match(/:assumed-role\/([^/]+)\//);
    return !!platformRoleName && !!assumedMatch && assumedMatch[1] === platformRoleName;
}

/** Best available human-readable principal, preferring the role over the session. */
export function principalOf(identity: ParsedCloudTrailEvent['userIdentity']): string {
    return (
        identity?.arn ??
        identity?.sessionContext?.sessionIssuer?.arn ??
        identity?.userName ??
        identity?.principalId ??
        'unknown'
    );
}

/**
 * Build the resourceId in the SAME shape Application Auto Scaling uses
 * ("service/<cluster>/<service>"), so a CloudTrail row and an activity-API row
 * for one service agree, and inventoryIdentityKeys() in normalize.ts resolves it
 * against inventory (which stores the service ARN).
 *
 * `cluster` in requestParameters may be a bare name OR a full ARN — take the last
 * path segment either way. A missing cluster means the default cluster.
 */
export function ecsResourceId(requestParameters: Record<string, unknown> | undefined): { resourceId: string; clusterName: string; serviceName: string } | null {
    const rawService = requestParameters?.service;
    if (typeof rawService !== 'string' || !rawService) return null;
    const serviceName = rawService.split('/').pop() ?? rawService;

    const rawCluster = requestParameters?.cluster;
    const clusterName =
        typeof rawCluster === 'string' && rawCluster ? (rawCluster.split('/').pop() ?? rawCluster) : 'default';

    return { resourceId: `service/${clusterName}/${serviceName}`, clusterName, serviceName };
}

function toRawActivity(parsed: ParsedCloudTrailEvent, scope: ScalingScope): RawScalingActivity | null {
    if (!parsed.eventID || !parsed.eventTime) return null;

    const principal = principalOf(parsed.userIdentity);
    let resourceId: string;
    let clusterName: string | undefined;
    let serviceName: string | undefined;
    let asgName: string | undefined;
    let desiredAfter: number | undefined;

    if (scope === 'ecs') {
        const ids = ecsResourceId(parsed.requestParameters);
        if (!ids) return null; // an UpdateService that named no service isn't a capacity change
        ({ resourceId, clusterName, serviceName } = ids);
        const dc = parsed.requestParameters?.desiredCount;
        if (typeof dc === 'number') desiredAfter = dc;
    } else {
        const name = parsed.requestParameters?.autoScalingGroupName;
        if (typeof name !== 'string' || !name) return null;
        resourceId = name;
        asgName = name;
        const dc = parsed.requestParameters?.desiredCapacity;
        if (typeof dc === 'number') desiredAfter = dc;
    }

    // A call that named no desired capacity did not change capacity — e.g. an
    // UpdateService that only swapped the task definition, or an
    // UpdateAutoScalingGroup that only touched health-check settings. Recording
    // those would flood the record with non-capacity events.
    if (desiredAfter === undefined) return null;

    return {
        activityId: parsed.eventID, // natural dedup key via (tenantId, source, activityId)
        resourceId,
        asgName,
        clusterName,
        serviceName,
        // CloudTrail has no "cause" prose. Synthesized and clearly labelled as
        // derived; the verbatim event is retained in rawPayload as the evidence.
        cause: `[CloudTrail] ${parsed.eventName ?? 'unknown'} called by ${principal}`,
        // Written in the SAME prose Application Auto Scaling uses, so the existing
        // extractCapacityFromDescription() in cause-classifier.ts recovers
        // desiredAfter through the normal path — no special-casing, and CloudTrail
        // rows carry capacity figures exactly like every other row.
        description:
            scope === 'ecs'
                ? `Setting desired count to ${desiredAfter}.`
                : `Setting desired capacity to ${desiredAfter}.`,
        // MUST be terminal. A CloudTrail event has no statusCode of its own, and
        // isTerminalStatus(undefined) is false — which would make index.ts defer
        // the row forever and pin this source's watermark, reintroducing the bug
        // fixed for 'Unfulfilled'. A recorded API call is already final: it either
        // succeeded or returned errorCode.
        statusCode: parsed.errorCode ? 'Failed' : 'Successful',
        statusMessage: parsed.errorCode ? `${parsed.errorCode}: ${parsed.errorMessage ?? ''}`.trim() : undefined,
        startedAt: new Date(parsed.eventTime),
        rawPayload: parsed as unknown as Record<string, unknown>,
        actor: principal,
        // Only IAMUser/Root name a person outright. An AssumedRole is used by
        // humans (SSO) AND machines (CI/CD pipelines, other schedulers) alike, so
        // claiming 'user' for it would assert something the evidence does not
        // support. The principal ARN above IS the evidence — a reader can tell an
        // SSO session from a CodePipeline role; we decline to guess on their behalf.
        actorType: ['IAMUser', 'Root'].includes(parsed.userIdentity?.type ?? '') ? 'user' : 'unattributed_out_of_band',
        // The MECHANISM, which is all CloudTrail actually proves: a capacity change
        // made by calling the API directly, outside any scaling policy. Deliberately
        // NOT 'manual' — see the note on scalingTypeOverride in types.ts.
        scalingTypeOverride: 'direct_api',
    };
}

/**
 * Fetch out-of-band capacity changes for one account/region since `sinceAt`.
 * Returns the same PollOutcome shape as the ASG/AAS clients so index.ts can
 * treat all three sources identically.
 */
export async function fetchCloudTrailCapacityChanges(
    assumed: AssumedCredentials,
    region: string,
    sinceAt: Date | null,
    now: Date,
    /** The account's configured NucleusAccess role — used to exclude this
     *  platform's OWN scheduler actions, which belong to source='platform'. */
    platformRoleArn?: string
): Promise<PollOutcome & { retentionClamped: boolean; platformSkipped: number }> {
    const client = new CloudTrailClient({
        region,
        credentials: assumed.credentials?.accessKeyId
            ? {
                  accessKeyId: assumed.credentials.accessKeyId,
                  secretAccessKey: assumed.credentials.secretAccessKey,
                  sessionToken: assumed.credentials.sessionToken,
              }
            : undefined,
    });

    const events: RawScalingActivity[] = [];
    let apiCallCount = 0;
    let pagesFetched = 0;
    let truncated = false;
    let oldestActivitySeenAt: Date | null = null;
    let newestActivitySeenAt: Date | null = null;
    let platformSkipped = 0;

    // Clamp to Event history's ~90-day ceiling. Asking earlier silently returns
    // nothing, which would look like "no manual changes" — the exact
    // indistinguishability this module exists to prevent, so the caller is told.
    const retentionFloor = new Date(now.getTime() - CLOUDTRAIL_RETENTION_DAYS * 86400_000);
    const requestedStart = sinceAt ?? retentionFloor;
    const startTime = requestedStart < retentionFloor ? retentionFloor : requestedStart;
    const retentionClamped = requestedStart < retentionFloor;

    try {
        for (const { eventName, scope } of WATCHED_EVENTS) {
            // LookupEvents accepts only ONE LookupAttribute per call, hence one
            // call per event name rather than a single filtered query.
            let nextToken: string | undefined;
            do {
                const response = await withCloudTrailRetry(() =>
                    client.send(
                        new LookupEventsCommand({
                            LookupAttributes: [{ AttributeKey: LookupAttributeKey.EVENT_NAME, AttributeValue: eventName }],
                            StartTime: startTime,
                            EndTime: now,
                            MaxResults: 50,
                            NextToken: nextToken,
                        })
                    )
                );
                apiCallCount += 1;
                pagesFetched += 1;

                for (const evt of (response.Events ?? []) as CloudTrailLookupEvent[]) {
                    if (!evt.CloudTrailEvent) continue;
                    let parsed: ParsedCloudTrailEvent;
                    try {
                        // CloudTrailEvent is a JSON *string*, not an object.
                        parsed = JSON.parse(evt.CloudTrailEvent) as ParsedCloudTrailEvent;
                    } catch {
                        continue; // unparseable payload — skip rather than fabricate
                    }
                    if (!isHumanPrincipal(parsed.userIdentity)) continue;
                    // This platform's own scheduler, not an out-of-band human.
                    if (isPlatformPrincipal(parsed.userIdentity, platformRoleArn)) {
                        platformSkipped += 1;
                        continue;
                    }

                    const activity = toRawActivity(parsed, scope);
                    if (!activity) continue;

                    events.push(activity);
                    if (!oldestActivitySeenAt || activity.startedAt < oldestActivitySeenAt) oldestActivitySeenAt = activity.startedAt;
                    if (!newestActivitySeenAt || activity.startedAt > newestActivitySeenAt) newestActivitySeenAt = activity.startedAt;
                }

                nextToken = response.NextToken;
                if (pagesFetched >= SCALING_AUDIT_CONFIG.maxPagesPerScope && nextToken) {
                    truncated = true;
                    break;
                }
            } while (nextToken);
            if (truncated) break;
        }

        return { events, apiCallCount, pagesFetched, truncated, oldestActivitySeenAt, newestActivitySeenAt, retentionClamped, platformSkipped };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const reason =
            message.includes('AccessDenied') || message.includes('not authorized')
                ? 'access_denied'
                : message.includes('Throttl')
                  ? 'throttled'
                  : 'aws_api_error';
        return {
            events,
            apiCallCount,
            pagesFetched,
            truncated,
            oldestActivitySeenAt,
            newestActivitySeenAt,
            retentionClamped,
            platformSkipped,
            error: { reason, message },
        };
    }
}
