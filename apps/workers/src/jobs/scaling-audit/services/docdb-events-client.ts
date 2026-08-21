// workers/src/jobs/scaling-audit/services/docdb-events-client.ts
//
// DocumentDB AWS-initiated event polling — the aws_api source for scope='docdb'.
// Decided scope (mirrors RDS, since DocumentDB's management API is structurally a
// near-clone of RDS's): instance-class changes and read-replica add/remove.
//
// Uses @aws-sdk/client-docdb's DescribeEventsCommand — a SEPARATE package and API
// namespace from RDS (docdb.<region>.amazonaws.com), even though the operation
// shape is a near-clone of rds:DescribeEvents. This client has no RDS/DocumentDB
// collision problem: the docdb.<region>.amazonaws.com endpoint only ever knows
// about this account's DocumentDB resources. Contrast with
// docdb-cloudtrail-client.ts, where the SAME calls surface in CloudTrail under
// rds.amazonaws.com and collide with genuine RDS activity — see that file's
// header comment.
//
// DescribeEvents imposes two AWS ceilings this client must respect:
//   - Only the past 14 days are queryable at all (source: AWS API docs — "for the
//     past 14 days"). Far short of ASG/AAS's ~6-week activity-API retention and
//     CloudTrail's ~90-day window: a first-ever (backfill) poll, or one that
//     resumes after a long gap, can never see further back than 14 days
//     regardless of SCALING_AUDIT_CONFIG.awsRetentionDays (38d) — that constant
//     is calibrated for the ASG/AAS sources and does not describe this one.
//   - Only MaxRecords/Marker pagination (mirrors RDS/ASG's own cursor style).
//
// DocumentDB storage does NOT autoscale the way RDS storage does: it grows
// automatically with the cluster volume (SSD-backed, 6-way replicated across
// AZs) with no customer-configurable threshold and no API call that drives it.
// Verified against both the AWS docs ("Amazon DocumentDB storage automatically
// scales... in 10 GiB increments, up to 128 TiB" — no scaling *action*, just
// continuous background growth) and DescribeEvents' own category/message
// reference (event-subscriptions.categories-messages.html): the full list of
// db-instance categories is availability / configuration change / creation /
// deletion / failure / notification / recovery / security patching, and the full
// list of db-cluster categories is creation / deletion / failover / maintenance /
// notification — neither table has a storage-scaling category or message
// anywhere. So this client never sets scalingTypeOverride to
// 'storage_autoscaling'; every row is 'direct_api' per the decided scope.
import { createHash } from 'node:crypto';
import { DocDBClient, DescribeEventsCommand, SourceType, type Event as DocDbEvent } from '@aws-sdk/client-docdb';
import type { AssumedCredentials } from '../../discovery/types.js';
import type { PollOutcome, RawScalingActivity } from '../types.js';
import { SCALING_AUDIT_CONFIG } from '../config.js';

/** AWS hard ceiling for DescribeEvents — see header comment. Deliberately NOT
 *  SCALING_AUDIT_CONFIG.awsRetentionDays (38d), which describes ASG/AAS only. */
export const DOCDB_EVENTS_RETENTION_DAYS = 14;

/**
 * Event categories worth capturing under the decided scope (instance-class
 * change, read-replica add/remove). Requested server-side via EventCategories so
 * the restart/stop/health/backup/patching noise DescribeEvents can also return
 * for a db-instance source is never fetched in the first place.
 */
const WATCHED_CATEGORIES = ['configuration change', 'creation', 'deletion'];

/**
 * Both messages below fall under the 'configuration change' category alongside
 * the two we DO want. Excluded here because:
 *   - "Applying modification to an instance class." fires at the START of a
 *     class-change; "Finished applying modification to an instance class."
 *     fires at completion. Keeping only the terminal one avoids a duplicate
 *     pair of rows for a single logical change (both would carry the exact same
 *     prose — DescribeEvents' Message text names no instance class value on
 *     either side, so there is nothing more to learn from the first one).
 *   - "Reset primary credentials." is a configuration change but never a
 *     scaling action.
 */
const SKIPPED_CONFIG_MESSAGES = new Set<string>(['Applying modification to an instance class.', 'Reset primary credentials.']);

/**
 * Pure predicate over one DescribeEvents row — exported so the skip rules above
 * are unit-testable without constructing a DocDBClient. Re-checks EventCategories
 * client-side even though the request already asks for WATCHED_CATEGORIES
 * server-side: the server-side filter is an optimization (fewer pages fetched),
 * this is the actual guarantee — it must hold even if AWS ever returns a category
 * outside what was requested.
 */
export function isCapacityRelevantDocDbEvent(e: Pick<DocDbEvent, 'SourceType' | 'Message' | 'EventCategories'>): boolean {
    if (e.SourceType !== SourceType.db_instance) return false; // defensive — see decided-scope note above; no cluster-level event qualifies
    if (!e.Message) return false;
    if (!e.EventCategories?.some((c) => WATCHED_CATEGORIES.includes(c))) return false;
    return !SKIPPED_CONFIG_MESSAGES.has(e.Message);
}

/**
 * DescribeEvents has no stable per-event ID (unlike ASG/AAS ActivityId or
 * CloudTrail eventID) — this is the closest thing to a natural key: the same
 * (source, message, timestamp) triple recurring across overlapping polls dedupes
 * via the (tenantId, source, activityId) unique constraint in db-writer.ts;
 * two distinct events for the same instance in the same second with the same
 * message text are indistinguishable to DescribeEvents itself, so collapsing
 * them is a feature, not a bug.
 */
export function docDbEventActivityId(sourceIdentifier: string, message: string, date: Date): string {
    return createHash('sha256').update(`${sourceIdentifier}|${message}|${date.toISOString()}`).digest('hex');
}

function toRawActivity(e: DocDbEvent): RawScalingActivity | null {
    if (!e.SourceIdentifier || !e.Date || !isCapacityRelevantDocDbEvent(e)) return null;

    return {
        activityId: docDbEventActivityId(e.SourceIdentifier, e.Message!, e.Date),
        resourceId: e.SourceIdentifier,
        cause: e.Message!,
        // Every DescribeEvents row is a completed, historical fact by
        // construction — there is no "in progress" state this API reports.
        statusCode: 'Successful',
        startedAt: e.Date,
        rawPayload: e as unknown as Record<string, unknown>,
        // The MECHANISM this source actually proves: AWS recorded an
        // API-triggered change. No storage-autoscaling case exists for
        // DocumentDB — see header comment.
        scalingTypeOverride: 'direct_api',
    };
}

/**
 * Fetch AWS-recorded DocumentDB instance events (instance-class change,
 * read-replica add/remove) for one account/region since `sinceAt`, clamped to
 * DescribeEvents' ~14-day ceiling. Returns the same PollOutcome shape as every
 * other scaling-audit source so index.ts can treat all of them identically.
 */
export async function fetchDocDbEvents(assumed: AssumedCredentials, region: string, sinceAt: Date | null, now: Date): Promise<PollOutcome> {
    const client = new DocDBClient({
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
    let marker: string | undefined;

    const retentionFloor = new Date(now.getTime() - DOCDB_EVENTS_RETENTION_DAYS * 86400_000);
    const startTime = sinceAt && sinceAt > retentionFloor ? sinceAt : retentionFloor;

    try {
        do {
            const response = await client.send(
                new DescribeEventsCommand({
                    SourceType: SourceType.db_instance,
                    EventCategories: WATCHED_CATEGORIES,
                    StartTime: startTime,
                    EndTime: now,
                    MaxRecords: 100,
                    Marker: marker,
                })
            );
            apiCallCount += 1;
            pagesFetched += 1;

            for (const evt of response.Events ?? []) {
                const activity = toRawActivity(evt);
                if (!activity) continue;
                events.push(activity);
                if (!oldestActivitySeenAt || activity.startedAt < oldestActivitySeenAt) oldestActivitySeenAt = activity.startedAt;
                if (!newestActivitySeenAt || activity.startedAt > newestActivitySeenAt) newestActivitySeenAt = activity.startedAt;
            }

            marker = response.Marker;
            if (pagesFetched >= SCALING_AUDIT_CONFIG.maxPagesPerScope && marker) {
                truncated = true;
                break;
            }
        } while (marker);

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
