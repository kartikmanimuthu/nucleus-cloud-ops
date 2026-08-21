// workers/src/jobs/scaling-audit/services/elasticache-cloudtrail-client.ts
//
// CloudTrail capture of ElastiCache capacity changes. ElastiCache has no
// unified "scaling activity" API to poll as an aws_api source (nothing like
// ASG's DescribeScalingActivities) — every capacity change is a direct
// ModifyCacheCluster / ModifyReplicationGroup / ModifyReplicationGroupShardConfiguration /
// IncreaseReplicaCount / DecreaseReplicaCount call, so CloudTrail is the SOLE
// source for this scope (see the "no aws_api fetcher" note below for why
// DescribeEvents was investigated and rejected).
//
// Structurally mirrors cloudtrail-client.ts's fetchCloudTrailCapacityChanges
// almost exactly, and reuses its isHumanPrincipal / isPlatformPrincipal /
// principalOf directly rather than reimplementing them — same reasoning
// applies verbatim: automated calls (AWS service principals, or this
// platform's own cross-account role) must be filtered out so this source
// stays complementary rather than redundant.
//
// IMPORTANT — the watched event names are NOT just "ModifyCacheCluster +
// ModifyReplicationGroup". Verified against the ElastiCache API reference
// (2026-08):
//   - ModifyReplicationGroup's ONLY capacity-relevant field is CacheNodeType
//     (vertical scaling / node-type change). It has NO NumNodeGroups or
//     replica-count parameter.
//   - Shard (node group) count changes are a SEPARATE call:
//     ModifyReplicationGroupShardConfiguration, param NodeGroupCount.
//   - Replica count changes are TWO SEPARATE calls: IncreaseReplicaCount /
//     DecreaseReplicaCount, param NewReplicaCount (top-level, cluster-mode-
//     disabled) or a per-shard ReplicaConfiguration array (cluster-mode-enabled).
// These three ARE also exactly the calls ElastiCache's own Application Auto
// Scaling integration for Valkey/Redis makes on your behalf via the
// AWSServiceRoleForApplicationAutoScaling_ElastiCacheRG service-linked role —
// i.e. ElastiCache DOES have an automatic scaling mechanism for shards/replicas
// (target-tracking or scheduled scaling), even though it has no automatic
// mechanism for CacheNodeType or Memcached NumCacheNodes. Those
// auto-scaling-triggered calls are attributed to that service-linked role and
// get filtered out by isHumanPrincipal / isPlatformPrincipal exactly like
// Application-Auto-Scaling-driven ECS calls are in cloudtrail-client.ts.
//
// No aws_api fetcher: elasticache:DescribeEvents was investigated as a
// possible second (aws_api) source. It reliably surfaces exactly ONE
// capacity-relevant, parseable message — "Finished modifying number of nodes
// from X to Y" (SourceType=cache-cluster), confirmed verbatim in AWS's own
// DescribeEvents/describe-events documentation — which covers only the
// Memcached NumCacheNodes dimension, and only its completion, not its request
// (CloudTrail already covers the request side of that same dimension). It has
// NOTHING recognizable for CacheNodeType (vertical scaling) or
// replication-group shard/replica changes: those surface only as generic
// failover/recovery text ("Recovering cache nodes X", "Finished recovery for
// cache nodes X") indistinguishable from any unrelated failover. Partial
// coverage of 1 of 3 capacity dimensions doesn't justify a second
// file/watermark/test suite — CloudTrail alone is the source here.
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

/**
 * API calls that change ElastiCache capacity. See the module doc comment for
 * why this list is five names, not two, and for the exact capacity-relevant
 * field each one is gated on.
 */
const WATCHED_EVENTS = [
    'ModifyCacheCluster',
    'ModifyReplicationGroup',
    'ModifyReplicationGroupShardConfiguration',
    'IncreaseReplicaCount',
    'DecreaseReplicaCount',
] as const;

/** CloudTrail Event history retains ~90 days; never ask for more. */
const CLOUDTRAIL_RETENTION_DAYS = 90;

interface ParsedElastiCacheCloudTrailEvent {
    eventID?: string;
    eventName?: string;
    eventTime?: string;
    errorCode?: string;
    errorMessage?: string;
    userIdentity?: Parameters<typeof isHumanPrincipal>[0];
    requestParameters?: Record<string, unknown>;
}

/**
 * Whether a CloudTrail call to one of WATCHED_EVENTS actually changed
 * capacity, and if so, the resourceId + human-readable description.
 *
 * A call touching neither capacity-relevant field (e.g. a ModifyCacheCluster
 * that only changed PreferredMaintenanceWindow, or a ModifyReplicationGroup
 * that only rotated the AuthToken) is not a capacity change — same principle
 * as the ECS/ASG client's toRawActivity "no desired capacity named" skip.
 *
 * Field names verified against real requestParameters casing in AWS's own
 * CloudTrail example events for ModifyCacheCluster (cacheClusterId,
 * numCacheNodes, cacheNodeType, applyImmediately, all lower-camelCase).
 * replicationGroupId / nodeGroupCount / newReplicaCount / replicaConfiguration
 * follow the same lower-camelCase convention this Query-protocol service uses
 * throughout — not directly confirmed against a captured example, since none
 * was found in the public docs, but consistent across every other field name
 * this service logs.
 */
export function matchElastiCacheCapacityChange(
    eventName: string | undefined,
    params: Record<string, unknown> | undefined
): { resourceId: string; description: string } | null {
    switch (eventName) {
        case 'ModifyCacheCluster': {
            const cacheClusterId = params?.cacheClusterId;
            if (typeof cacheClusterId !== 'string' || !cacheClusterId) return null;
            const numCacheNodes = params?.numCacheNodes;
            const cacheNodeType = params?.cacheNodeType;
            const parts: string[] = [];
            if (typeof numCacheNodes === 'number') parts.push(`NumCacheNodes to ${numCacheNodes}`);
            if (typeof cacheNodeType === 'string') parts.push(`CacheNodeType to ${cacheNodeType}`);
            if (parts.length === 0) return null; // e.g. only touched maintenance window / parameter group
            return { resourceId: cacheClusterId, description: `Setting ${parts.join(' and ')}.` };
        }
        case 'ModifyReplicationGroup': {
            const replicationGroupId = params?.replicationGroupId;
            if (typeof replicationGroupId !== 'string' || !replicationGroupId) return null;
            const cacheNodeType = params?.cacheNodeType;
            if (typeof cacheNodeType !== 'string' || !cacheNodeType) return null; // no other field on this call is capacity-relevant
            return { resourceId: replicationGroupId, description: `Setting CacheNodeType to ${cacheNodeType}.` };
        }
        case 'ModifyReplicationGroupShardConfiguration': {
            const replicationGroupId = params?.replicationGroupId;
            if (typeof replicationGroupId !== 'string' || !replicationGroupId) return null;
            const nodeGroupCount = params?.nodeGroupCount;
            if (typeof nodeGroupCount !== 'number') return null;
            return { resourceId: replicationGroupId, description: `Setting node group (shard) count to ${nodeGroupCount}.` };
        }
        case 'IncreaseReplicaCount':
        case 'DecreaseReplicaCount': {
            const replicationGroupId = params?.replicationGroupId;
            if (typeof replicationGroupId !== 'string' || !replicationGroupId) return null;
            const newReplicaCount = params?.newReplicaCount;
            // Cluster-mode-enabled callers may configure replica count per shard
            // instead of one top-level value — still a capacity change even
            // though no single number applies to the whole replication group.
            const perShard = Array.isArray(params?.replicaConfiguration) && params.replicaConfiguration.length > 0;
            if (typeof newReplicaCount !== 'number' && !perShard) return null;
            return {
                resourceId: replicationGroupId,
                description:
                    typeof newReplicaCount === 'number'
                        ? `Setting replica count to ${newReplicaCount}.`
                        : 'Setting replica count per shard.',
            };
        }
        default:
            return null;
    }
}

function toRawActivity(parsed: ParsedElastiCacheCloudTrailEvent): RawScalingActivity | null {
    if (!parsed.eventID || !parsed.eventTime) return null;

    const match = matchElastiCacheCapacityChange(parsed.eventName, parsed.requestParameters);
    if (!match) return null;

    const principal = principalOf(parsed.userIdentity);

    return {
        activityId: parsed.eventID, // natural dedup key via (tenantId, source, activityId)
        resourceId: match.resourceId,
        // CloudTrail has no "cause" prose. Synthesized and clearly labelled as
        // derived; the verbatim event is retained in rawPayload as the evidence.
        cause: `[CloudTrail] ${parsed.eventName ?? 'unknown'} called by ${principal}`,
        description: match.description,
        // MUST be terminal — see cloudtrail-client.ts's identical note. A
        // recorded API call is already final: it either succeeded or returned
        // errorCode.
        statusCode: parsed.errorCode ? 'Failed' : 'Successful',
        statusMessage: parsed.errorCode ? `${parsed.errorCode}: ${parsed.errorMessage ?? ''}`.trim() : undefined,
        startedAt: new Date(parsed.eventTime),
        rawPayload: parsed as unknown as Record<string, unknown>,
        actor: principal,
        // Only IAMUser/Root name a person outright — see cloudtrail-client.ts's
        // identical note on why AssumedRole cannot be asserted as human.
        actorType: ['IAMUser', 'Root'].includes(parsed.userIdentity?.type ?? '') ? 'user' : 'unattributed_out_of_band',
        // The MECHANISM only — deliberately NOT 'manual'. See the note on
        // scalingTypeOverride in types.ts.
        scalingTypeOverride: 'direct_api',
    };
}

/**
 * Fetch ElastiCache capacity changes for one account/region since `sinceAt`.
 * Returns the same PollOutcome shape as every other scaling-audit source so
 * index.ts can treat it identically.
 */
export async function fetchElastiCacheCloudTrailCapacityChanges(
    assumed: AssumedCredentials,
    region: string,
    sinceAt: Date | null,
    now: Date,
    /** The account's configured NucleusAccess role — used to exclude this
     *  platform's OWN actions, which belong to source='platform'. */
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

    // Clamp to Event history's ~90-day ceiling — see cloudtrail-client.ts's
    // identical note on why silently returning nothing would be worse than clamping.
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
                    let parsed: ParsedElastiCacheCloudTrailEvent;
                    try {
                        // CloudTrailEvent is a JSON *string*, not an object.
                        parsed = JSON.parse(evt.CloudTrailEvent) as ParsedElastiCacheCloudTrailEvent;
                    } catch {
                        continue; // unparseable payload — skip rather than fabricate
                    }
                    if (!isHumanPrincipal(parsed.userIdentity)) continue;
                    // This platform's own role, not an out-of-band human — see
                    // cloudtrail-client.ts's isPlatformPrincipal doc comment.
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
