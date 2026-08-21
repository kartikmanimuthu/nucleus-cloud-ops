// workers/src/jobs/scaling-audit/services/asg-client.ts
//
// ASG scaling-activity polling. Deliberately unfiltered by AutoScalingGroupName —
// DescribeScalingActivities with no group name returns every activity in the
// account/region, which (a) removes the ordering dependency on the discovery
// job's inventory, and (b) still captures activities for ASGs deleted before
// today's poll. AWS retains ~6 weeks of history regardless of filters.
import { AutoScalingClient, DescribeScalingActivitiesCommand, type Activity } from '@aws-sdk/client-auto-scaling';
import type { AssumedCredentials } from '../../discovery/types.js';
import type { PollOutcome, RawScalingActivity } from '../types.js';
import { SCALING_AUDIT_CONFIG } from '../config.js';

function toRawActivity(a: Activity): RawScalingActivity {
    return {
        activityId: a.ActivityId!,
        resourceId: a.AutoScalingGroupName!,
        asgName: a.AutoScalingGroupName,
        cause: a.Cause ?? '',
        description: a.Description,
        statusCode: a.StatusCode,
        statusMessage: a.StatusMessage,
        startedAt: a.StartTime!,
        endedAt: a.EndTime,
        progress: a.Progress,
        rawPayload: a as unknown as Record<string, unknown>,
    };
}

/**
 * Fetch ASG scaling activities for one account/region, paginating backwards
 * (AWS returns newest-first) until either the watermark is crossed or
 * maxPagesPerScope is hit. `sinceAt` is the watermark minus the configured
 * overlap — pass null on the very first (backfill) poll for this scope.
 */
export async function fetchAsgActivities(assumed: AssumedCredentials, region: string, sinceAt: Date | null): Promise<PollOutcome> {
    const client = new AutoScalingClient({
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

    try {
        do {
            const response = await client.send(
                new DescribeScalingActivitiesCommand({
                    IncludeDeletedGroups: true,
                    MaxRecords: 100,
                    NextToken: nextToken,
                    Filters: sinceAt ? [{ Name: 'StartTimeLowerBound', Values: [sinceAt.toISOString()] }] : undefined,
                })
            );
            apiCallCount += 1;
            pagesFetched += 1;

            for (const activity of response.Activities ?? []) {
                if (!activity.ActivityId || !activity.StartTime) continue;
                events.push(toRawActivity(activity));
                if (!oldestActivitySeenAt || activity.StartTime < oldestActivitySeenAt) oldestActivitySeenAt = activity.StartTime;
                if (!newestActivitySeenAt || activity.StartTime > newestActivitySeenAt) newestActivitySeenAt = activity.StartTime;
            }

            nextToken = response.NextToken;
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
