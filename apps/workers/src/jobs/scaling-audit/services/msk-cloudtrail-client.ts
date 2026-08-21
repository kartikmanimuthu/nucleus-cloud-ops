// workers/src/jobs/scaling-audit/services/msk-cloudtrail-client.ts
//
// CloudTrail attribution for MSK broker capacity changes (the "cloudtrail"
// source for scope='msk').
//
// Structurally the same role cloudtrail-client.ts plays for ASG/ECS, just
// applied to a source that is ALREADY rich rather than thin:
// ListClusterOperationsV2 (msk-operations-client.ts) gives OperationType/
// OperationState/timing but — exactly like ASG's DescribeScalingActivities —
// never names a caller. CloudTrail is the only source for that. Unlike
// ASG/ECS, MSK has no passive scaling-policy path at all: every capacity
// change is an explicit API call, always (see the scalingTypeOverride note
// below) — CloudTrail here exists purely to answer "who", never "what
// mechanism triggered this".
import {
    CloudTrailClient,
    LookupEventsCommand,
    LookupAttributeKey,
    type Event as CloudTrailLookupEvent,
} from '@aws-sdk/client-cloudtrail';
import type { AssumedCredentials } from '../../discovery/types.js';
import type { PollOutcome, RawScalingActivity } from '../types.js';
import { SCALING_AUDIT_CONFIG } from '../config.js';
import { withCloudTrailRetry } from './cloudtrail-retry.js';
import { isHumanPrincipal, isPlatformPrincipal, principalOf } from './cloudtrail-client.js';
import { clusterNameFromArn } from './msk-operations-client.js';

/**
 * MSK's own APIs that change broker capacity — the exact three the decided MSK
 * scope covers (see msk-operations-client.ts's WATCHED_OPERATION_TYPES). No
 * config changes, no cluster create/delete — same "narrow on purpose"
 * reasoning as cloudtrail-client.ts's WATCHED_EVENTS.
 */
const WATCHED_EVENTS = ['UpdateBrokerCount', 'UpdateBrokerStorage', 'UpdateBrokerType'] as const;

/**
 * CloudTrail Event history retains ~90 days; never ask for more. Duplicated
 * from cloudtrail-client.ts's identical constant rather than imported — it
 * isn't exported there, and that file is being read from concurrently by 3
 * sibling agents (RDS/ElastiCache/DocDB also import isHumanPrincipal/
 * isPlatformPrincipal/principalOf from it), so it's left untouched here.
 */
const CLOUDTRAIL_RETENTION_DAYS = 90;

interface ParsedCloudTrailEvent {
    eventID?: string;
    eventName?: string;
    eventTime?: string;
    errorCode?: string;
    errorMessage?: string;
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
 * Pure mapping from one parsed CloudTrail event to a RawScalingActivity.
 * Exported for unit testing (mirrors cloudtrail-client.test.ts's density).
 */
export function toRawActivity(parsed: ParsedCloudTrailEvent): RawScalingActivity | null {
    if (!parsed.eventID || !parsed.eventTime) return null;

    const clusterArn = parsed.requestParameters?.clusterArn;
    if (typeof clusterArn !== 'string' || !clusterArn) return null; // not a cluster-scoped call — malformed/unexpected

    // Same ARN-derived name msk-operations-client.ts uses — the cluster name
    // lives IN the ARN, so both sources land on the identical resourceId
    // without ever cross-referencing each other.
    const resourceId = clusterNameFromArn(clusterArn) ?? clusterArn;
    const principal = principalOf(parsed.userIdentity);

    let description: string | undefined;
    if (parsed.eventName === 'UpdateBrokerCount') {
        const target = parsed.requestParameters?.targetNumberOfBrokerNodes;
        description = typeof target === 'number' ? `Setting broker count to ${target}.` : undefined;
    } else if (parsed.eventName === 'UpdateBrokerType') {
        const target = parsed.requestParameters?.targetInstanceType;
        description = typeof target === 'string' ? `Setting broker instance type to ${target}.` : undefined;
    } else if (parsed.eventName === 'UpdateBrokerStorage') {
        description = 'Updating broker EBS storage size.';
    }

    return {
        activityId: parsed.eventID, // natural dedup key via (tenantId, source, activityId)
        resourceId,
        clusterName: resourceId,
        // CloudTrail has no "cause" prose of its own — synthesized and clearly
        // labelled as derived, same convention as cloudtrail-client.ts. The
        // verbatim event is retained in rawPayload as the evidence.
        cause: `[CloudTrail] ${parsed.eventName ?? 'unknown'} called by ${principal}`,
        description,
        // MUST be terminal — same reasoning as cloudtrail-client.ts: a recorded
        // API call is already final (it either succeeded or came back with an
        // errorCode). isTerminalStatus(undefined) is false, and leaving this
        // unset would defer the row forever (watermark.ts, not edited here).
        statusCode: parsed.errorCode ? 'Failed' : 'Successful',
        statusMessage: parsed.errorCode ? `${parsed.errorCode}: ${parsed.errorMessage ?? ''}`.trim() : undefined,
        startedAt: new Date(parsed.eventTime),
        rawPayload: parsed as unknown as Record<string, unknown>,
        actor: principal,
        // Only IAMUser/Root name a person outright — an AssumedRole is used by
        // humans (SSO) AND machines (CI/CD, other schedulers) alike. Identical
        // reasoning to cloudtrail-client.ts.
        actorType: ['IAMUser', 'Root'].includes(parsed.userIdentity?.type ?? '') ? 'user' : 'unattributed_out_of_band',
        // The MECHANISM only — and for MSK there is no other value this could
        // ever be: unlike ASG/ECS, MSK has NO passive scaling-policy path at
        // all, so every capacity change is a direct API call by construction.
        // Still deliberately not 'manual' — see the note on scalingTypeOverride
        // in types.ts: AssumedRole covers pipelines as much as humans.
        scalingTypeOverride: 'direct_api',
    };
}

/**
 * Fetch CloudTrail attribution for MSK broker capacity changes
 * (UpdateBrokerCount/UpdateBrokerStorage/UpdateBrokerType) for one
 * account/region since `sinceAt`. Same PollOutcome-plus shape as
 * fetchCloudTrailCapacityChanges so index.ts (not edited here) can
 * orchestrate every scope's cloudtrail source identically.
 */
export async function fetchMskCloudTrailCapacityChanges(
    assumed: AssumedCredentials,
    region: string,
    sinceAt: Date | null,
    now: Date,
    /** This platform's own scheduler assuming the customer's role — excluded
     *  for the same reason cloudtrail-client.ts excludes it (see
     *  isPlatformPrincipal): those changes belong to source='platform'. */
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

    // Clamp to Event history's ~90-day ceiling — same reasoning as
    // cloudtrail-client.ts: asking earlier silently returns nothing, which
    // would look like "no manual changes" rather than "we couldn't look".
    const retentionFloor = new Date(now.getTime() - CLOUDTRAIL_RETENTION_DAYS * 86400_000);
    const requestedStart = sinceAt ?? retentionFloor;
    const startTime = requestedStart < retentionFloor ? retentionFloor : requestedStart;
    const retentionClamped = requestedStart < retentionFloor;

    try {
        for (const eventName of WATCHED_EVENTS) {
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

                    const activity = toRawActivity(parsed);
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
