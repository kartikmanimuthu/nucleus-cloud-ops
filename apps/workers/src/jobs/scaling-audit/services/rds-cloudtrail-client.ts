// workers/src/jobs/scaling-audit/services/rds-cloudtrail-client.ts
//
// CloudTrail capture of RDS capacity changes (cloudtrail source) — mirrors
// cloudtrail-client.ts's fetchCloudTrailCapacityChanges() shape exactly, for
// the RDS scope's agreed coverage: instance class changes, manual storage
// bumps, and read-replica add/remove. (Storage AUTOSCALING completions are a
// separate, AWS-initiated source — see rds-events-client.ts; CloudTrail never
// sees those, since RDS performs them internally with no caller identity to
// log.)
//
// Every capture here is a DIRECT API CALL outside any AWS-managed automation,
// which is exactly what scalingTypeOverride: 'direct_api' means (see the doc
// comment on that field in types.ts) — never 'manual': an AssumedRole is used
// by humans and CI/CD pipelines alike, so asserting a person made the change
// would claim something the evidence doesn't support. Same reasoning,
// same isHumanPrincipal/isPlatformPrincipal/principalOf filters, reused
// verbatim from cloudtrail-client.ts rather than reimplemented.
//
// ── THE RDS/DOCUMENTDB CLOUDTRAIL COLLISION — read before touching WATCHED_EVENTS ──
//
// DocumentDB API calls are logged to CloudTrail as calls to the RDS API — same
// eventSource (rds.amazonaws.com), same eventName, same ARN shape
// (arn:aws:rds:{region}:{account}:db:{name}) as a genuine RDS instance making
// the identical call (see docdb-cloudtrail-client.ts's header comment for the
// full citation trail). ModifyDBInstance and DeleteDBInstance carry no Engine
// field, so a naive watch of those two names here would also capture every
// DocumentDB instance's changes and mislabel them as RDS.
//
// Resolution, mirroring docdb-cloudtrail-client.ts's own fix: cross-check the
// event's dBInstanceIdentifier against a live DescribeDBInstances snapshot
// taken from the RDS — not DocDB — control plane. That endpoint only ever
// enumerates genuine RDS instances, so this excludes every DocumentDB
// instance sharing the same CloudTrail vocabulary. CreateDBInstanceReadReplica
// needs no such check: DocumentDB has no equivalent call (it adds replicas via
// plain CreateDBInstance), so that event name never collides.
//
// Known gap (shared with the DocDB side): an instance whose DeleteDBInstance
// has already finished by the time this snapshot runs no longer appears in
// DescribeDBInstances, so a same-poll deletion can be missed rather than
// mislabeled. Missing is the correct failure mode here — mislabeling as the
// other engine would be worse for a compliance record.
import {
    CloudTrailClient,
    LookupEventsCommand,
    LookupAttributeKey,
    type Event as CloudTrailLookupEvent,
} from '@aws-sdk/client-cloudtrail';
import { RDSClient, DescribeDBInstancesCommand } from '@aws-sdk/client-rds';
import type { AssumedCredentials } from '../../discovery/types.js';
import type { PollOutcome, RawScalingActivity } from '../types.js';
import { SCALING_AUDIT_CONFIG } from '../config.js';
import { withCloudTrailRetry } from './cloudtrail-retry.js';
import { isHumanPrincipal, isPlatformPrincipal, principalOf } from './cloudtrail-client.js';

/**
 * RDS API calls that change capacity. Deliberately narrow, matching the
 * agreed RDS scope: no engine-version upgrades, parameter-group changes, or
 * backup/snapshot events (ModifyDBInstance covers far more than capacity —
 * see classifyRdsCloudTrailEvent's field-presence filter below for how the
 * non-capacity calls are excluded).
 */
const WATCHED_EVENTS = ['ModifyDBInstance', 'CreateDBInstanceReadReplica', 'DeleteDBInstance'] as const;
type WatchedEventName = (typeof WATCHED_EVENTS)[number];

/** CloudTrail Event history retains ~90 days; never ask for more. Same
 *  ceiling as cloudtrail-client.ts's CLOUDTRAIL_RETENTION_DAYS (that constant
 *  is private to this module, not re-exported, hence the local copy). */
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

export interface RdsCloudTrailClassification {
    resourceId: string;
    description: string;
}

/**
 * Pure classification of one watched RDS call into (resourceId, description),
 * or null when the call named no capacity change for THIS scope. Split out
 * from toRawActivity so it is directly testable without constructing a full
 * parsed CloudTrail event — mirrors ecsResourceId()'s role in
 * cloudtrail-client.ts.
 *
 * CloudTrail lowercases the first letter of each RDS request-parameter name
 * (RDS's API model capitalizes them, e.g. "DBInstanceClass") — verified
 * against published CloudTrail log examples for rds.amazonaws.com: request
 * parameters appear as dBInstanceIdentifier / dBInstanceClass /
 * allocatedStorage / sourceDBInstanceIdentifier, never the PascalCase form.
 */
export function classifyRdsCloudTrailEvent(
    eventName: string,
    requestParameters: Record<string, unknown> | undefined
): RdsCloudTrailClassification | null {
    const rp = requestParameters ?? {};
    const dbInstanceId = rp.dBInstanceIdentifier;
    if (typeof dbInstanceId !== 'string' || !dbInstanceId) return null;

    if (eventName === 'ModifyDBInstance') {
        const newClass = rp.dBInstanceClass;
        const newStorage = rp.allocatedStorage;
        const changesClass = typeof newClass === 'string' && !!newClass;
        const changesStorage = typeof newStorage === 'number';
        // A ModifyDBInstance call touching neither field is not a capacity
        // change for this job (e.g. it only rotated the master password or
        // changed a security group) — same principle as the ECS/ASG client's
        // "no desired capacity named" skip in cloudtrail-client.ts.
        if (!changesClass && !changesStorage) return null;

        const parts: string[] = [];
        if (changesClass) parts.push(`instance class -> ${newClass}`);
        if (changesStorage) parts.push(`allocated storage -> ${newStorage} GiB`);
        return { resourceId: dbInstanceId, description: `Modified: ${parts.join(', ')}.` };
    }

    if (eventName === 'CreateDBInstanceReadReplica') {
        const source = rp.sourceDBInstanceIdentifier;
        return {
            resourceId: dbInstanceId,
            description: typeof source === 'string' ? `Read replica added (source: ${source}).` : 'Read replica added.',
        };
    }

    if (eventName === 'DeleteDBInstance') {
        // Best-effort, by design: CloudTrail's DeleteDBInstance request carries
        // no field saying "this was a replica" — that context only exists on
        // the DESCRIBE response (ReadReplicaDBInstanceIdentifiers /
        // ReadReplicaSourceDBInstanceIdentifier on the live DBInstance), which
        // this event doesn't include and which may no longer be queryable
        // once the instance is gone. Resolution: capture EVERY DeleteDBInstance
        // call rather than trying to guess primary-vs-replica from the
        // deletion event alone — a primary deletion is itself audit-relevant
        // and must not be silently dropped to be conservative about replicas.
        // The resource-detail page's own inventory/cluster context is left to
        // disambiguate which case a given row was, for a human reader.
        return { resourceId: dbInstanceId, description: 'DB instance deleted (primary or read replica — see resourceId).' };
    }

    return null;
}

function toRawActivity(parsed: ParsedCloudTrailEvent, eventName: WatchedEventName): RawScalingActivity | null {
    if (!parsed.eventID || !parsed.eventTime) return null;

    const classification = classifyRdsCloudTrailEvent(eventName, parsed.requestParameters);
    if (!classification) return null;

    const principal = principalOf(parsed.userIdentity);

    return {
        activityId: parsed.eventID, // natural dedup key via (tenantId, source, activityId)
        resourceId: classification.resourceId,
        // CloudTrail has no "cause" prose of its own — synthesized and clearly
        // labelled as derived, same convention as cloudtrail-client.ts. The
        // verbatim event is retained in rawPayload as the evidence.
        cause: `[CloudTrail] ${eventName} called by ${principal}`,
        description: classification.description,
        // MUST be terminal — see the identical note in cloudtrail-client.ts's
        // toRawActivity: a CloudTrail event has no statusCode of its own, and a
        // recorded API call is already final (it either succeeded or returned
        // errorCode).
        statusCode: parsed.errorCode ? 'Failed' : 'Successful',
        statusMessage: parsed.errorCode ? `${parsed.errorCode}: ${parsed.errorMessage ?? ''}`.trim() : undefined,
        startedAt: new Date(parsed.eventTime),
        rawPayload: parsed as unknown as Record<string, unknown>,
        actor: principal,
        // Only IAMUser/Root name a person outright — an AssumedRole is used by
        // humans (SSO) AND machines (CI/CD pipelines, other schedulers) alike.
        // Identical reasoning to cloudtrail-client.ts.
        actorType: ['IAMUser', 'Root'].includes(parsed.userIdentity?.type ?? '') ? 'user' : 'unattributed_out_of_band',
        // The MECHANISM only — a capacity change made by calling the API
        // directly, with no scaling policy involved (RDS has none for these
        // three operations). Deliberately NOT 'manual' — see types.ts.
        scalingTypeOverride: 'direct_api',
    };
}

/**
 * Fetch RDS capacity changes (instance class, storage, read replicas) for one
 * account/region since `sinceAt`. Same PollOutcome + retentionClamped +
 * platformSkipped shape as fetchCloudTrailCapacityChanges in
 * cloudtrail-client.ts, so index.ts (wired separately) can treat every
 * cloudtrail-source fetcher identically.
 */
function credentialsFor(assumed: AssumedCredentials) {
    return assumed.credentials?.accessKeyId
        ? {
              accessKeyId: assumed.credentials.accessKeyId,
              secretAccessKey: assumed.credentials.secretAccessKey,
              sessionToken: assumed.credentials.sessionToken,
          }
        : undefined;
}

/**
 * Live snapshot of this account/region's RDS instance identifiers, read from
 * the RDS (not DocDB) control plane — see the header comment for why that
 * makes every identifier here unambiguously a genuine RDS instance.
 */
async function fetchKnownRdsInstanceIds(assumed: AssumedCredentials, region: string): Promise<Set<string>> {
    const client = new RDSClient({ region, credentials: credentialsFor(assumed) });
    const ids = new Set<string>();
    let marker: string | undefined;
    do {
        const response = await client.send(new DescribeDBInstancesCommand({ MaxRecords: 100, Marker: marker }));
        for (const instance of response.DBInstances ?? []) {
            if (instance.DBInstanceIdentifier) ids.add(instance.DBInstanceIdentifier);
        }
        marker = response.Marker;
    } while (marker);
    return ids;
}

export async function fetchRdsCloudTrailCapacityChanges(
    assumed: AssumedCredentials,
    region: string,
    sinceAt: Date | null,
    now: Date,
    /** The account's configured NucleusAccess role — excludes this platform's
     *  OWN scheduler actions, which belong to source='platform'. */
    platformRoleArn?: string
): Promise<PollOutcome & { retentionClamped: boolean; platformSkipped: number }> {
    const client = new CloudTrailClient({ region, credentials: credentialsFor(assumed) });

    const events: RawScalingActivity[] = [];
    let apiCallCount = 0;
    let pagesFetched = 0;
    let truncated = false;
    let oldestActivitySeenAt: Date | null = null;
    let newestActivitySeenAt: Date | null = null;
    let platformSkipped = 0;

    const retentionFloor = new Date(now.getTime() - CLOUDTRAIL_RETENTION_DAYS * 86400_000);
    const requestedStart = sinceAt ?? retentionFloor;
    const startTime = requestedStart < retentionFloor ? retentionFloor : requestedStart;
    const retentionClamped = requestedStart < retentionFloor;

    try {
        // See header comment — Modify/Delete carry no Engine field, so this is
        // the only way to tell an RDS instance apart from an identically-shaped
        // DocumentDB one sharing the same CloudTrail eventName.
        const knownRdsInstanceIds = await fetchKnownRdsInstanceIds(assumed, region);

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
                        parsed = JSON.parse(evt.CloudTrailEvent) as ParsedCloudTrailEvent;
                    } catch {
                        continue; // unparseable payload — skip rather than fabricate
                    }
                    if (!isHumanPrincipal(parsed.userIdentity)) continue;
                    if (isPlatformPrincipal(parsed.userIdentity, platformRoleArn)) {
                        platformSkipped += 1;
                        continue;
                    }

                    const activity = toRawActivity(parsed, eventName);
                    if (!activity) continue;

                    // CreateDBInstanceReadReplica has no DocumentDB equivalent
                    // call name (see header comment), so it never collides and
                    // needs no cross-check. Modify/Delete need the live
                    // cross-check to exclude DocumentDB's identically-shaped calls.
                    if (eventName !== 'CreateDBInstanceReadReplica' && !knownRdsInstanceIds.has(activity.resourceId)) continue;

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
