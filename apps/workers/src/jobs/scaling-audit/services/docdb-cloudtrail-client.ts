// workers/src/jobs/scaling-audit/services/docdb-cloudtrail-client.ts
//
// CloudTrail capture of out-of-band DocumentDB capacity changes — the aws_api
// source's counterpart for scope='docdb'. See docdb-events-client.ts for that
// source and for why storage scaling is never tracked at all (DocumentDB has no
// user-driven storage-scaling mechanism).
//
// ── THE RDS/DOCUMENTDB CLOUDTRAIL COLLISION — read before touching WATCHED_EVENTS ──
//
// Per AWS's own docs ("Logging Amazon DocumentDB API calls with AWS CloudTrail"):
// "Amazon DocumentDB console, AWS CLI, and API calls are logged as calls made to
// the Amazon RDS API." Confirmed against the DocumentDB IAM permissions reference
// (UsingWithRDS.IAM.ResourcePermissions.html), which states outright: "To specify
// an action, use the rds: prefix" and lists CreateDBInstance/ModifyDBInstance/
// DeleteDBInstance under `rds:CreateDBInstance` etc. — NOT a docdb:-prefixed
// namespace — with resource ARNs of the form
// arn:aws:rds:{region}:{account}:db:{name}. That is the SAME eventSource
// (rds.amazonaws.com), the SAME eventName, and the SAME ARN SHAPE that a genuine
// RDS instance uses for the identical call.
//
// LookupEvents supports exactly one filter attribute per call (eventName here),
// so a lookup for "ModifyDBInstance" returns every account RDS instance
// modification AND every DocumentDB one, with no server-side way to tell them
// apart. This is a real correctness hazard for whichever of the RDS/DocumentDB
// scaling-audit fetchers does not account for it — an unfiltered version of
// either would silently mislabel the other engine's changes as its own.
//
// Resolution used here:
//   - CreateDBInstance is fully reliable on its own: the DocumentDB SDK's
//     CreateDBInstanceMessage.Engine is a REQUIRED field with a single valid
//     value, 'docdb' (verified against the @aws-sdk/client-docdb type model).
//     CloudTrail's requestParameters.engine for this call is exact — no
//     cross-check needed.
//   - ModifyDBInstance and DeleteDBInstance carry no Engine field (you don't
//     restate the engine to modify or delete an existing instance), so this
//     client cross-checks the event's dBInstanceIdentifier against a live
//     DescribeDBInstances snapshot taken from the DocDB — not RDS — control
//     plane. That endpoint only ever enumerates its own engine's instances, so
//     every identifier it returns is unambiguously a DocumentDB instance.
//
// Known gap: an instance whose DeleteDBInstance has already finished by the time
// this snapshot runs no longer appears in DescribeDBInstances, so a same-poll
// replica removal can be missed if the delete completed before this poll ran.
// This is a limitation of CloudTrail's shared RDS/DocumentDB vocabulary, not a
// bug in this file — flagged for the orchestrator, same as the primary-vs-replica
// ambiguity below.
//
// ── PRIMARY-VS-REPLICA AMBIGUITY ──
//
// DocumentDB adds a replica by calling CreateDBInstance with an existing
// DBClusterIdentifier — there is no separate "CreateDBInstanceReadReplica" call
// the way RDS has. That means CreateDBInstance also fires for the FIRST instance
// of a brand-new cluster (not a scaling action at all), and DeleteDBInstance
// fires identically whether the removed instance was a replica or the last
// instance in the cluster. CloudTrail cannot distinguish "add/remove a replica"
// from "stand up/tear down the cluster's first/last instance" — both are the
// same API call shape. Resolution: capture every qualifying CreateDBInstance /
// DeleteDBInstance as scalingTypeOverride='direct_api' (mechanism only, see
// types.ts) and let a human reviewer use the cause text plus the surrounding
// scaling_events history for that cluster to judge intent — the same posture
// cause-classifier.ts already takes everywhere else (it refuses to guess intent
// the evidence doesn't support).
import { CloudTrailClient, LookupEventsCommand, LookupAttributeKey, type Event as CloudTrailLookupEvent } from '@aws-sdk/client-cloudtrail';
import { DocDBClient, DescribeDBInstancesCommand } from '@aws-sdk/client-docdb';
import { isHumanPrincipal, isPlatformPrincipal, principalOf } from './cloudtrail-client.js';
import type { AssumedCredentials } from '../../discovery/types.js';
import type { PollOutcome, RawScalingActivity } from '../types.js';
import { SCALING_AUDIT_CONFIG } from '../config.js';
import { withCloudTrailRetry } from './cloudtrail-retry.js';

/** DocDB API calls in scope — see header comment for why each is included. */
const WATCHED_EVENTS = ['ModifyDBInstance', 'CreateDBInstance', 'DeleteDBInstance'] as const;
type WatchedEventName = (typeof WATCHED_EVENTS)[number];

/** Same ~90-day Event history ceiling every scaling-audit CloudTrail source
 *  respects — see cloudtrail-client.ts for the full rationale. */
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
 * Live snapshot of this account/region's DocumentDB instance identifiers, read
 * from the DocDB (not RDS) control plane — see the header comment for why that
 * makes every identifier here unambiguously DocumentDB.
 */
async function fetchKnownDocDbInstanceIds(assumed: AssumedCredentials, region: string): Promise<Set<string>> {
    const client = new DocDBClient({ region, credentials: credentialsFor(assumed) });
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

/**
 * Extracts (resourceId, a human-readable detail fragment) from one watched
 * event's requestParameters, applying the decided-scope filter for each call —
 * or null when the call doesn't qualify (not a class-change Modify, not a
 * docdb-engine Create). Pure and exported so the filtering rules are
 * unit-testable without CloudTrail or DocDB SDK mocks.
 *
 * Mirrors ecsResourceId() in cloudtrail-client.ts: extraction and "is this a
 * capacity change at all" both live here, cause-text assembly stays in the
 * caller (principal attribution isn't this function's concern).
 */
export function docDbResourceId(
    eventName: string | undefined,
    requestParameters: Record<string, unknown> | undefined
): { resourceId: string; detail?: string } | null {
    const instanceId = requestParameters?.dBInstanceIdentifier;
    if (typeof instanceId !== 'string' || !instanceId) return null;

    if (eventName === 'ModifyDBInstance') {
        // A ModifyDBInstance that didn't touch the instance class (e.g. only
        // changed the maintenance window or master password) is not a scaling
        // action — decided scope is instance-class changes only.
        const newClass = requestParameters?.dBInstanceClass;
        if (typeof newClass !== 'string' || !newClass) return null;
        return { resourceId: instanceId, detail: newClass };
    }

    if (eventName === 'CreateDBInstance') {
        // The one reliable RDS/DocumentDB discriminator — see header comment.
        if (requestParameters?.engine !== 'docdb') return null;
        const dbClass = requestParameters?.dBInstanceClass;
        return { resourceId: instanceId, detail: typeof dbClass === 'string' ? dbClass : undefined };
    }

    if (eventName === 'DeleteDBInstance') {
        return { resourceId: instanceId };
    }

    return null;
}

function toRawActivity(parsed: ParsedCloudTrailEvent): RawScalingActivity | null {
    if (!parsed.eventID || !parsed.eventTime) return null;
    const extracted = docDbResourceId(parsed.eventName, parsed.requestParameters);
    if (!extracted) return null;

    const principal = principalOf(parsed.userIdentity);
    const detailSuffix = extracted.detail ? ` (${extracted.detail})` : '';

    return {
        activityId: parsed.eventID, // natural dedup key via (tenantId, source, activityId)
        resourceId: extracted.resourceId,
        // CloudTrail has no "cause" prose of its own — synthesized and clearly
        // labelled as derived, same convention as cloudtrail-client.ts. The
        // verbatim event is retained in rawPayload as the evidence.
        cause: `[CloudTrail] ${parsed.eventName} called by ${principal}${detailSuffix}`,
        // MUST be terminal — see watermark.ts's isTerminalStatus doc comment. A
        // recorded CloudTrail API call is already final: it either succeeded or
        // carries errorCode.
        statusCode: parsed.errorCode ? 'Failed' : 'Successful',
        statusMessage: parsed.errorCode ? `${parsed.errorCode}: ${parsed.errorMessage ?? ''}`.trim() : undefined,
        startedAt: new Date(parsed.eventTime),
        rawPayload: parsed as unknown as Record<string, unknown>,
        actor: principal,
        // Only IAMUser/Root name a person outright — an AssumedRole covers CI/CD
        // pipelines and other automation just as much as human SSO sessions. See
        // cloudtrail-client.ts's identical reasoning.
        actorType: ['IAMUser', 'Root'].includes(parsed.userIdentity?.type ?? '') ? 'user' : 'unattributed_out_of_band',
        // The MECHANISM only — never 'manual'. See types.ts on scalingTypeOverride.
        scalingTypeOverride: 'direct_api',
    };
}

/**
 * Fetch out-of-band DocumentDB capacity changes (instance-class change,
 * read-replica add/remove) for one account/region since `sinceAt`. Returns the
 * same PollOutcome shape (plus retentionClamped/platformSkipped) as
 * cloudtrail-client.ts's fetchCloudTrailCapacityChanges, so index.ts can treat
 * every scaling-audit CloudTrail source identically.
 */
export async function fetchDocDbCloudTrailCapacityChanges(
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
        // the only way to tell a DocumentDB instance apart from an
        // identically-shaped RDS one sharing the same CloudTrail eventName.
        const knownDocDbInstanceIds = await fetchKnownDocDbInstanceIds(assumed, region);

        for (const eventName of WATCHED_EVENTS satisfies readonly WatchedEventName[]) {
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

                    const activity = toRawActivity(parsed);
                    if (!activity) continue;

                    // CreateDBInstance is already exact (engine==='docdb' checked
                    // inside docDbResourceId). Modify/Delete need the live
                    // cross-check to exclude RDS's identically-shaped calls.
                    if (parsed.eventName !== 'CreateDBInstance' && !knownDocDbInstanceIds.has(activity.resourceId)) continue;

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
