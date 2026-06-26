// workers/src/jobs/right-sizing/services/metric-collector.ts
//
// CloudWatch metric collector (RS-008).
// For a set of resources in one account+region, batches GetMetricData requests
// (≤ 500 queries/request), handles throttling with retry/backoff, and returns the
// per-period Average series per resource+signal. Cross-account access via assumed
// credentials (the worker AssumeRoles before calling this).
//
// Memory (CWAgent mem_used_percent) is best-effort — absent metrics simply yield no
// datapoints and the signal is omitted (the engine flags it).
import {
    CloudWatchClient,
    GetMetricDataCommand,
    type MetricDataQuery,
} from '@aws-sdk/client-cloudwatch';
import { createLogger } from '../../../lib/logger.js';
import type { AssumedCredentials } from '../../discovery/types.js';
import { RESOURCE_TYPES, type AnalyzableResource, type CollectedMetrics, type SignalKey } from '../types.js';

const log = createLogger('right-sizing-metric-collector');
const MAX_QUERIES_PER_CALL = 500;

interface MetricSpec {
    signal: SignalKey;
    namespace: string;
    metricName: string;
    /** Dimension name; value comes from the resource (resourceId or metadata). */
    dimensionName: string;
    stat: string; // Average | Sum | Maximum
}

/** CloudWatch dimension value for a resource (override via metadata when present). */
function dimensionValue(r: AnalyzableResource, dimName: string): string {
    const md = r.metadata || {};
    // Common metadata keys discovered by the scanner.
    if (dimName === 'DBInstanceIdentifier') {
        return (md.dbInstanceIdentifier as string) || (md.DBInstanceIdentifier as string) || r.resourceId;
    }
    if (dimName === 'AutoScalingGroupName') {
        return (md.autoScalingGroupName as string) || (r.name as string) || r.resourceId;
    }
    return r.resourceId;
}

function specsFor(resourceType: string): MetricSpec[] {
    switch (resourceType) {
        case RESOURCE_TYPES.EC2:
            return [
                { signal: 'cpu', namespace: 'AWS/EC2', metricName: 'CPUUtilization', dimensionName: 'InstanceId', stat: 'Average' },
                { signal: 'networkIn', namespace: 'AWS/EC2', metricName: 'NetworkIn', dimensionName: 'InstanceId', stat: 'Average' },
                { signal: 'networkOut', namespace: 'AWS/EC2', metricName: 'NetworkOut', dimensionName: 'InstanceId', stat: 'Average' },
                { signal: 'diskReadOps', namespace: 'AWS/EC2', metricName: 'EBSReadOps', dimensionName: 'InstanceId', stat: 'Average' },
                { signal: 'diskWriteOps', namespace: 'AWS/EC2', metricName: 'EBSWriteOps', dimensionName: 'InstanceId', stat: 'Average' },
                // Best-effort memory via CloudWatch agent.
                { signal: 'memory', namespace: 'CWAgent', metricName: 'mem_used_percent', dimensionName: 'InstanceId', stat: 'Average' },
            ];
        case RESOURCE_TYPES.RDS:
            return [
                { signal: 'cpu', namespace: 'AWS/RDS', metricName: 'CPUUtilization', dimensionName: 'DBInstanceIdentifier', stat: 'Average' },
                { signal: 'freeableMemory', namespace: 'AWS/RDS', metricName: 'FreeableMemory', dimensionName: 'DBInstanceIdentifier', stat: 'Average' },
                { signal: 'connections', namespace: 'AWS/RDS', metricName: 'DatabaseConnections', dimensionName: 'DBInstanceIdentifier', stat: 'Average' },
                { signal: 'diskReadOps', namespace: 'AWS/RDS', metricName: 'ReadIOPS', dimensionName: 'DBInstanceIdentifier', stat: 'Average' },
                { signal: 'diskWriteOps', namespace: 'AWS/RDS', metricName: 'WriteIOPS', dimensionName: 'DBInstanceIdentifier', stat: 'Average' },
            ];
        case RESOURCE_TYPES.EBS:
            return [
                { signal: 'diskReadOps', namespace: 'AWS/EBS', metricName: 'VolumeReadOps', dimensionName: 'VolumeId', stat: 'Sum' },
                { signal: 'diskWriteOps', namespace: 'AWS/EBS', metricName: 'VolumeWriteOps', dimensionName: 'VolumeId', stat: 'Sum' },
                { signal: 'throughputPercent', namespace: 'AWS/EBS', metricName: 'VolumeThroughputPercentage', dimensionName: 'VolumeId', stat: 'Average' },
                { signal: 'burstBalance', namespace: 'AWS/EBS', metricName: 'BurstBalance', dimensionName: 'VolumeId', stat: 'Average' },
            ];
        case RESOURCE_TYPES.ASG:
            return [
                { signal: 'cpu', namespace: 'AWS/EC2', metricName: 'CPUUtilization', dimensionName: 'AutoScalingGroupName', stat: 'Average' },
            ];
        default:
            return [];
    }
}

/** Encode/decode a stable query id ↔ (resourceIndex, signal). */
function queryId(idx: number, signal: SignalKey): string {
    return `q_${idx}_${signal}`;
}

function chunk<T>(arr: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

export interface CollectOptions {
    lookbackDays: number;
    periodSeconds: number;
    nowMs: number; // injected (Date.now() is unavailable in some sandboxes / for determinism)
}

export async function collect(
    resources: AnalyzableResource[],
    assumed: AssumedCredentials,
    region: string,
    opts: CollectOptions
): Promise<CollectedMetrics> {
    const result: CollectedMetrics = new Map();
    if (!resources.length) return result;

    const client = new CloudWatchClient({
        region,
        credentials: assumed.credentials?.accessKeyId
            ? {
                  accessKeyId: assumed.credentials.accessKeyId,
                  secretAccessKey: assumed.credentials.secretAccessKey,
                  sessionToken: assumed.credentials.sessionToken,
              }
            : undefined,
    });

    const endTime = new Date(opts.nowMs);
    const startTime = new Date(opts.nowMs - opts.lookbackDays * 24 * 60 * 60 * 1000);

    // Build a flat list of queries with a mapping back to (resource, signal).
    const queries: MetricDataQuery[] = [];
    const idMap = new Map<string, { resourceId: string; signal: SignalKey }>();
    resources.forEach((r, idx) => {
        result.set(r.resourceId, {});
        for (const spec of specsFor(r.resourceType)) {
            const id = queryId(idx, spec.signal);
            idMap.set(id, { resourceId: r.resourceId, signal: spec.signal });
            queries.push({
                Id: id,
                MetricStat: {
                    Metric: {
                        Namespace: spec.namespace,
                        MetricName: spec.metricName,
                        Dimensions: [{ Name: spec.dimensionName, Value: dimensionValue(r, spec.dimensionName) }],
                    },
                    Period: opts.periodSeconds,
                    Stat: spec.stat,
                },
                ReturnData: true,
            });
        }
    });

    for (const batch of chunk(queries, MAX_QUERIES_PER_CALL)) {
        let nextToken: string | undefined;
        let attempt = 0;
        do {
            try {
                const resp = await client.send(
                    new GetMetricDataCommand({
                        StartTime: startTime,
                        EndTime: endTime,
                        MetricDataQueries: batch,
                        NextToken: nextToken,
                        ScanBy: 'TimestampDescending',
                    })
                );
                for (const mdr of resp.MetricDataResults ?? []) {
                    const mapped = mdr.Id ? idMap.get(mdr.Id) : undefined;
                    if (!mapped) continue;
                    const bucket = result.get(mapped.resourceId)!;
                    const existing = bucket[mapped.signal] ?? [];
                    bucket[mapped.signal] = existing.concat((mdr.Values ?? []).filter((v) => v != null));
                }
                nextToken = resp.NextToken;
                attempt = 0;
            } catch (err) {
                attempt += 1;
                if (attempt > 3) {
                    log.error('GetMetricData failed after retries — skipping batch', { region, error: String(err) });
                    break;
                }
                await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
            }
        } while (nextToken);
    }

    log.info('Collected metrics', { region, resources: resources.length, queries: queries.length });
    return result;
}
