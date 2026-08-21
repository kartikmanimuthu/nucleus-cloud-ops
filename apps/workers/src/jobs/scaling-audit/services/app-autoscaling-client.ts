// workers/src/jobs/scaling-audit/services/app-autoscaling-client.ts
//
// ECS service scaling-activity polling via Application Auto Scaling. Deliberately
// unfiltered by ResourceId — DescribeScalingActivities with ServiceNamespace='ecs'
// and no ResourceId returns every ECS scaling activity in the account/region.
//
// Unlike the ASG API, this one has NO server-side time filter at all (no
// StartTimeLowerBound equivalent) — every page must be fetched and cut off
// client-side against the watermark. AWS retains ~6 weeks of history here too.
import {
    ApplicationAutoScalingClient,
    DescribeScalingActivitiesCommand,
    ServiceNamespace,
    type ScalingActivity,
} from '@aws-sdk/client-application-auto-scaling';
import type { AssumedCredentials } from '../../discovery/types.js';
import type { PollOutcome, RawScalingActivity } from '../types.js';
import { SCALING_AUDIT_CONFIG } from '../config.js';

/** "service/my-cluster/my-svc" -> { clusterName: 'my-cluster', serviceName: 'my-svc' } */
function parseEcsResourceId(resourceId: string): { clusterName?: string; serviceName?: string } {
    const m = resourceId.match(/^service\/([^/]+)\/([^/]+)$/);
    return m ? { clusterName: m[1], serviceName: m[2] } : {};
}

function toRawActivity(a: ScalingActivity): RawScalingActivity {
    const { clusterName, serviceName } = parseEcsResourceId(a.ResourceId ?? '');
    return {
        activityId: a.ActivityId!,
        resourceId: a.ResourceId!,
        clusterName,
        serviceName,
        scalableDimension: a.ScalableDimension,
        cause: a.Cause ?? '',
        description: a.Description,
        statusCode: a.StatusCode,
        statusMessage: a.StatusMessage,
        notScaledReasons: a.NotScaledReasons,
        startedAt: a.StartTime!,
        endedAt: a.EndTime,
        rawPayload: a as unknown as Record<string, unknown>,
    };
}

/**
 * Fetch ECS service scaling activities (Application Auto Scaling) for one
 * account/region, paginating until either `sinceAt` is crossed client-side or
 * maxPagesPerScope is hit. Results are newest-first, per AWS docs.
 */
export async function fetchEcsScalingActivities(assumed: AssumedCredentials, region: string, sinceAt: Date | null): Promise<PollOutcome> {
    const client = new ApplicationAutoScalingClient({
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
    let nextToken: string | undefined;
    let crossedWatermark = false;

    try {
        do {
            const response = await client.send(
                new DescribeScalingActivitiesCommand({
                    ServiceNamespace: ServiceNamespace.ECS,
                    MaxResults: 50,
                    NextToken: nextToken,
                    IncludeNotScaledActivities: SCALING_AUDIT_CONFIG.includeNotScaledActivities,
                })
            );
            apiCallCount += 1;
            pagesFetched += 1;

            for (const activity of response.ScalingActivities ?? []) {
                if (!activity.ActivityId || !activity.StartTime) continue;
                if (sinceAt && activity.StartTime < sinceAt) {
                    crossedWatermark = true;
                    continue;
                }
                events.push(toRawActivity(activity));
                if (!oldestActivitySeenAt || activity.StartTime < oldestActivitySeenAt) oldestActivitySeenAt = activity.StartTime;
                if (!newestActivitySeenAt || activity.StartTime > newestActivitySeenAt) newestActivitySeenAt = activity.StartTime;
            }

            nextToken = response.NextToken;
            if (crossedWatermark) break; // results are newest-first; nothing older is relevant
            if (pagesFetched >= SCALING_AUDIT_CONFIG.maxPagesPerScope && nextToken) {
                truncated = true;
                break;
            }
        } while (nextToken);

        return { events, apiCallCount, pagesFetched, truncated, oldestActivitySeenAt, newestActivitySeenAt };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const reason = message.includes('AccessDenied') || message.includes('not authorized') ? 'access_denied' : 'aws_api_error';
        return {
            events,
            apiCallCount,
            pagesFetched,
            truncated,
            oldestActivitySeenAt,
            newestActivitySeenAt,
            error: { reason, message },
        };
    }
}
