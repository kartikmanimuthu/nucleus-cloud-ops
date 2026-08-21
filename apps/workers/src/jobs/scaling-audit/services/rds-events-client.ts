// workers/src/jobs/scaling-audit/services/rds-events-client.ts
//
// RDS storage-autoscaling completions (aws_api source), read via
// rds:DescribeEvents.
//
// RDS exposes no equivalent of ASG's DescribeScalingActivities for storage
// autoscaling — the only trace that "RDS grew the volume for me" left behind
// is a db-instance Event, category "configuration change", whose Message is
// exactly one of two fixed strings (verified against AWS's own event-message
// reference, USER_Events.Messages.html, DB instance events table):
//   RDS-EVENT-0217  "Applying autoscaling-initiated modification to allocated storage."
//   RDS-EVENT-0218  "Finished applying autoscaling-initiated modification to allocated storage."
// Only 0218 (the "Finished" one) is captured — 0217 names the SAME operation
// while it is still in flight, and capturing both would record one storage
// resize twice. Neither message carries the new/old allocated-storage GiB
// figure (unlike the "setting allocated storage to X" wording this module's
// author was initially told to expect) — that number is not obtainable from
// this API at all; only CloudWatch's AllocatedStorage/FreeStorageSpace
// metrics carry it, and this fetcher deliberately stays enrichment-free, same
// as asg-client.ts.
//
// A failure to autoscale (RDS-EVENT-0223, category "failure": "Storage
// autoscaling is unable to scale the storage for the reason: ...") is
// deliberately NOT captured: every row this fetcher produces already
// happened by construction (see toRawActivity), and a failure-to-scale is a
// non-event for a capacity audit — nothing about capacity changed.
//
// DescribeEvents has no per-event ID (unlike ASG's ActivityId) — activityId
// is synthesized from (SourceIdentifier, Message, Date). That hash is a DEDUP
// KEY for the (tenantId, source, activityId) unique constraint, and is a
// SEPARATE thing from normalize.ts's causeFingerprint(), which hashes
// resourceId+cause for the unrelated causeFingerprint column.
import { createHash } from 'node:crypto';
import { RDSClient, DescribeEventsCommand, SourceType, type Event as RdsEvent } from '@aws-sdk/client-rds';
import type { AssumedCredentials } from '../../discovery/types.js';
import type { PollOutcome, RawScalingActivity, ScalingType } from '../types.js';
import { SCALING_AUDIT_CONFIG } from '../config.js';

const STORAGE_AUTOSCALING_TYPE: ScalingType = 'storage_autoscaling';

/** RDS Event history covers only ~14 days — far short of ASG's ~6 weeks or
 *  CloudTrail's ~90 days, and short of SCALING_AUDIT_CONFIG.awsRetentionDays
 *  (38d), which was tuned for the ASG/ECS activity APIs. A watermark older
 *  than this ceiling silently returns zero events, indistinguishable from "no
 *  autoscaling happened" unless the caller (index.ts, wired later) treats
 *  crossing it as a gap the same way the CloudTrail client's
 *  retentionClamped does. */
export const RDS_EVENTS_RETENTION_DAYS = 14;

/**
 * True only for the COMPLETION message (RDS-EVENT-0218). Deliberately
 * excludes:
 *   - RDS-EVENT-0217 "Applying..." — the same operation, still in flight.
 *   - RDS-EVENT-0017/0018 "Applying/Finished applying modification to
 *     allocated storage." (no "autoscaling" in the text) — a MANUAL storage
 *     change, which surfaces separately via rds-cloudtrail-client.ts's
 *     ModifyDBInstance capture instead, keeping the two sources
 *     complementary rather than duplicative (same principle as
 *     isHumanPrincipal() in cloudtrail-client.ts).
 *   - RDS-EVENT-0223 "Storage autoscaling is unable to scale..." — a
 *     failure, out of scope (see file header).
 */
export function isStorageAutoscalingCompletion(evt: Pick<RdsEvent, 'Message'>): boolean {
    const msg = (evt.Message ?? '').trim();
    return /^finished\b/i.test(msg) && /autoscaling/i.test(msg) && /allocated storage/i.test(msg);
}

/**
 * Synthesize a stable dedup key for one DescribeEvents row. DescribeEvents
 * carries no per-event ID (unlike ASG's ActivityId), so the same
 * (instance, message) pair recurring across re-polled, overlapping windows
 * would otherwise collide — hashing in the event's own Date keeps distinct
 * occurrences distinct while staying stable for the SAME occurrence across
 * re-polls.
 */
export function rdsEventActivityId(sourceIdentifier: string, message: string, date: Date): string {
    return createHash('sha256').update(`${sourceIdentifier}|${message}|${date.toISOString()}`).digest('hex');
}

function toRawActivity(evt: RdsEvent): RawScalingActivity | null {
    if (!evt.SourceIdentifier || !evt.Date) return null;
    if (evt.SourceType !== SourceType.db_instance) return null; // skip cluster/snapshot/etc. sources
    if (!isStorageAutoscalingCompletion(evt)) return null;

    const message = evt.Message ?? '';
    return {
        activityId: rdsEventActivityId(evt.SourceIdentifier, message, evt.Date),
        resourceId: evt.SourceIdentifier,
        cause: message,
        // A DescribeEvents row is reported only once RDS has already finished
        // the operation — there is no in-progress state to model here, unlike
        // ASG/Application Auto Scaling activities which can still be running
        // when polled.
        statusCode: 'Successful',
        startedAt: evt.Date,
        endedAt: evt.Date,
        rawPayload: evt as unknown as Record<string, unknown>,
        scalingTypeOverride: STORAGE_AUTOSCALING_TYPE,
    };
}

/**
 * Fetch RDS storage-autoscaling completions for one account/region, since
 * `sinceAt` (pass null on the first/backfill poll for this scope+source).
 * Same PollOutcome shape, pagination, and error-handling convention as
 * fetchAsgActivities in asg-client.ts.
 */
export async function fetchRdsStorageAutoscalingEvents(
    assumed: AssumedCredentials,
    region: string,
    sinceAt: Date | null
): Promise<PollOutcome> {
    const client = new RDSClient({
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

    const now = new Date();
    // Clamp to DescribeEvents' ~14-day ceiling — asking further back silently
    // returns nothing, which would look identical to "no autoscaling
    // happened" (the same failure mode CLOUDTRAIL_RETENTION_DAYS guards
    // against in cloudtrail-client.ts). Not surfaced as a `retentionClamped`
    // field here: this fetcher's contract is the plain PollOutcome, same as
    // asg-client.ts; index.ts's own gap-detection (staleForTooLong, tuned to
    // awsRetentionDays=38d) will need widening for this scope's much shorter
    // 14-day ceiling — flagged in the handoff report.
    const retentionFloor = new Date(now.getTime() - RDS_EVENTS_RETENTION_DAYS * 86400_000);
    const startTime = sinceAt && sinceAt > retentionFloor ? sinceAt : retentionFloor;

    try {
        do {
            const response = await client.send(
                new DescribeEventsCommand({
                    SourceType: SourceType.db_instance,
                    EventCategories: ['configuration change'],
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
