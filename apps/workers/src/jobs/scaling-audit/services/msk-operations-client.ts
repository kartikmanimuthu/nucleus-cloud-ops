// workers/src/jobs/scaling-audit/services/msk-operations-client.ts
//
// MSK broker capacity-change polling (the "aws_api" source for scope='msk').
//
// Structurally the closest analog is asg-client.ts, NOT the thinner
// Describe*Events APIs the RDS/ElastiCache/DocDB siblings poll. MSK has no
// passive scaling-policy mechanism at all — every capacity change is an
// explicit API call (UpdateBrokerCount/UpdateBrokerStorage/UpdateBrokerType),
// always. ListClusterOperationsV2 is MSK's own authoritative activity record:
// OperationType/OperationState/StartTime/EndTime, very close in shape to
// ASG's DescribeScalingActivities Activity objects — but, just like ASG, it
// never names a caller. msk-cloudtrail-client.ts supplies that half.
//
// Decided scope: broker-count, broker-storage, and broker-instance-type
// changes only — i.e. everything UpdateBrokerCount/UpdateBrokerStorage/
// UpdateBrokerType cover. No config changes, no cluster create/delete.
import {
    KafkaClient,
    ListClustersV2Command,
    ListClusterOperationsV2Command,
    type Cluster,
    type ClusterOperationV2Summary,
} from '@aws-sdk/client-kafka';
import type { AssumedCredentials } from '../../discovery/types.js';
import type { PollOutcome, RawScalingActivity } from '../types.js';
import { SCALING_AUDIT_CONFIG } from '../config.js';

/**
 * MSK cluster ARNs embed the cluster name: arn:aws:kafka:<region>:<account>:
 * cluster/<cluster-name>/<uuid>. Extracting it here (rather than looking it up
 * elsewhere) lets msk-cloudtrail-client.ts derive the IDENTICAL resourceId from
 * the ARN alone — CloudTrail's requestParameters only ever carry the ARN, never
 * a name — so the two sources agree on resourceId without cross-referencing
 * each other or a lookup table. MSK isn't in inventory_resources yet (no MSK
 * resource type in discovery/services/pg-writer.ts), so there is no third
 * source of truth to reconcile against either.
 */
const CLUSTER_ARN = /^arn:[^:]*:kafka:[^:]*:[^:]*:cluster\/([^/]+)\/.+$/;

export function clusterNameFromArn(clusterArn: string): string | undefined {
    return clusterArn.match(CLUSTER_ARN)?.[1];
}

/**
 * OperationType values ListClusterOperationsV2 returns for the decided MSK
 * scope, confirmed against AWS docs (msk-update-broker-count.html shows
 * INCREASE_BROKER_COUNT, msk-remove-broker.html shows DECREASE_BROKER_COUNT for
 * the same update-broker-count CLI/API call in the opposite direction,
 * msk-update-broker-type.html shows UPDATE_BROKER_TYPE). UPDATE_BROKER_STORAGE
 * is UpdateBrokerStorage's documented OperationType. Deliberately narrow: config
 * changes, Kafka-version upgrades, cluster create/delete, VPC connections etc.
 * all show up in the same API and are excluded on purpose — out of scope.
 */
export const WATCHED_OPERATION_TYPES: ReadonlySet<string> = new Set([
    'INCREASE_BROKER_COUNT',
    'DECREASE_BROKER_COUNT',
    'UPDATE_BROKER_STORAGE',
    'UPDATE_BROKER_TYPE',
]);

/**
 * Translate MSK's OperationState vocabulary into the two exact strings
 * watermark.ts's TERMINAL_STATUS_CODES already recognizes ('Successful' /
 * 'Failed') — reusing them makes MSK rows terminal for free, with zero changes
 * to that (shared, unedited) file. Any in-progress or unrecognized state (e.g.
 * PENDING, UPDATE_IN_PROGRESS) passes through verbatim: isTerminalStatus()'s
 * conservative "unrecognized = not terminal" default holds it back correctly.
 */
export function mapOperationState(state: string | undefined): string | undefined {
    if (state === 'UPDATE_COMPLETE') return 'Successful';
    if (state === 'UPDATE_FAILED') return 'Failed';
    return state;
}

/**
 * Pure mapping from one ListClusterOperationsV2 summary to a RawScalingActivity.
 * `clusterName` comes from the ListClustersV2 pass (the summary itself carries
 * no cluster name — only ClusterArn) and is preferred for resourceId; falls
 * back to the ARN when unknown, per the same fallback msk-cloudtrail-client.ts
 * uses when it can't resolve a name either.
 */
export function toRawActivity(op: ClusterOperationV2Summary, clusterName: string | undefined): RawScalingActivity | null {
    if (!op.OperationArn || !op.OperationType || !op.StartTime || !op.ClusterArn) return null;
    const resourceId = clusterName ?? op.ClusterArn;

    return {
        activityId: op.OperationArn, // ARN — stable and unique, natural dedup key
        resourceId,
        clusterName: resourceId,
        cause: `MSK ${op.OperationType} on cluster ${resourceId}`,
        statusCode: mapOperationState(op.OperationState),
        startedAt: op.StartTime,
        endedAt: op.EndTime,
        rawPayload: op as unknown as Record<string, unknown>,
        // MSK has NO passive scaling-policy path — every capacity change here is
        // an explicit API call, always. This proves the MECHANISM only, never
        // human intent — see the doc comment on scalingTypeOverride in types.ts.
        scalingTypeOverride: 'direct_api',
    };
}

/**
 * Fetch MSK broker capacity-change operations for one account/region.
 *
 * Two-step fan-out: ListClustersV2 enumerates clusters (serverless clusters
 * are skipped — they have no discrete brokers and cannot take
 * UpdateBrokerCount/Storage/Type, so querying their operation history would
 * never yield a watched OperationType), then ListClusterOperationsV2 is called
 * per cluster. Unlike DescribeScalingActivities, ListClusterOperationsV2 has no
 * server-side time filter, so `sinceAt` is applied client-side per page — same
 * pattern as app-autoscaling-client.ts.
 *
 * KNOWN GAP: pagesFetched/maxPagesPerScope is a budget shared across ALL
 * clusters in this account/region, not per-cluster. An account with more
 * clusters (or operation history) than the budget allows in one run will
 * never reach the later clusters in the list THIS run — and because the scope
 * watermark advances only to the newest activity actually seen
 * (computeWatermarkAdvance in watermark.ts, not edited here), an unvisited
 * cluster isn't specially retried next poll either; it's simply queried again
 * from the same watermark, same as every other cluster. In practice this
 * only bites accounts with more MSK clusters + operation history than
 * maxPagesPerScope (50) covers in one run. ponytail: acceptable for the
 * expected cluster counts; add a per-cluster watermark if that stops holding.
 */
export async function fetchMskOperations(assumed: AssumedCredentials, region: string, sinceAt: Date | null): Promise<PollOutcome> {
    const client = new KafkaClient({
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

    try {
        const clusters: Cluster[] = [];
        let clustersNextToken: string | undefined;
        do {
            const response = await client.send(new ListClustersV2Command({ MaxResults: 100, NextToken: clustersNextToken }));
            apiCallCount += 1;
            pagesFetched += 1;

            for (const c of response.ClusterInfoList ?? []) {
                if (c.ClusterArn && c.ClusterType !== 'SERVERLESS') clusters.push(c);
            }

            clustersNextToken = response.NextToken;
            if (pagesFetched >= SCALING_AUDIT_CONFIG.maxPagesPerScope && clustersNextToken) {
                truncated = true;
                break;
            }
        } while (clustersNextToken);

        outer: for (const cluster of clusters) {
            let opsNextToken: string | undefined;
            do {
                const response = await client.send(
                    new ListClusterOperationsV2Command({ ClusterArn: cluster.ClusterArn, MaxResults: 100, NextToken: opsNextToken })
                );
                apiCallCount += 1;
                pagesFetched += 1;

                for (const op of response.ClusterOperationInfoList ?? []) {
                    if (!op.OperationType || !WATCHED_OPERATION_TYPES.has(op.OperationType)) continue;
                    if (!op.StartTime || (sinceAt && op.StartTime < sinceAt)) continue;

                    const activity = toRawActivity({ ...op, ClusterArn: op.ClusterArn ?? cluster.ClusterArn }, cluster.ClusterName);
                    if (!activity) continue;

                    events.push(activity);
                    if (!oldestActivitySeenAt || op.StartTime < oldestActivitySeenAt) oldestActivitySeenAt = op.StartTime;
                    if (!newestActivitySeenAt || op.StartTime > newestActivitySeenAt) newestActivitySeenAt = op.StartTime;
                }

                opsNextToken = response.NextToken;
                if (pagesFetched >= SCALING_AUDIT_CONFIG.maxPagesPerScope && opsNextToken) {
                    truncated = true;
                    break outer;
                }
            } while (opsNextToken);
        }

        return { events, apiCallCount, pagesFetched, truncated, oldestActivitySeenAt, newestActivitySeenAt };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const reason =
            message.includes('AccessDenied') || message.includes('not authorized') || message.includes('Forbidden')
                ? 'access_denied'
                : message.includes('Throttl') || message.includes('TooManyRequests')
                  ? 'throttled'
                  : 'aws_api_error';
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
