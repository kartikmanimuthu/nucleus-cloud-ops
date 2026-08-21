// workers/src/lib/cloudwatch-client.ts
//
// Shared CloudWatch GetMetricData helper (SA-003). Lives in lib/, not
// jobs/scaling-audit/services/, because the capacity-planning job reuses the
// same batching/retry machinery for its own hourly utilization poll — this file
// takes no dependency on any job's types, only on AssumedCredentials.
//
// Modeled on jobs/right-sizing/services/metric-collector.ts: same batching
// (<=500 queries/call), same retry/backoff. What's different here is WHY the
// window matters — right-sizing wants a rolling lookback ending "now"; this
// wants the state immediately BEFORE a specific past event, which is why
// results are read back per-event from a shared time series rather than one
// query per data point.
import { CloudWatchClient, GetMetricDataCommand, type MetricDataQuery } from '@aws-sdk/client-cloudwatch';
import { createLogger } from './logger.js';
import type { AssumedCredentials } from '../jobs/discovery/types.js';

const log = createLogger('cloudwatch-client');
const MAX_QUERIES_PER_CALL = 500;

function chunk<T>(arr: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

function buildClient(assumed: AssumedCredentials, region: string): CloudWatchClient {
    return new CloudWatchClient({
        region,
        credentials: assumed.credentials?.accessKeyId
            ? {
                  accessKeyId: assumed.credentials.accessKeyId,
                  secretAccessKey: assumed.credentials.secretAccessKey,
                  sessionToken: assumed.credentials.sessionToken,
              }
            : undefined,
    });
}

interface SeriesPoint {
    t: number; // epoch ms
    v: number;
}

/** Runs a batch of MetricDataQueries (ScanBy TimestampDescending) and returns
 *  each query's full datapoint series. Never throws — a metric outage degrades
 *  to "no series", the same as the metric never having existed. */
async function runQueries(
    cw: CloudWatchClient,
    queries: MetricDataQuery[],
    startTime: Date,
    endTime: Date
): Promise<Map<string, SeriesPoint[]>> {
    const out = new Map<string, SeriesPoint[]>();
    for (const batch of chunk(queries, MAX_QUERIES_PER_CALL)) {
        let attempt = 0;
        for (;;) {
            try {
                const resp = await cw.send(
                    new GetMetricDataCommand({
                        StartTime: startTime,
                        EndTime: endTime,
                        MetricDataQueries: batch,
                        ScanBy: 'TimestampDescending',
                    })
                );
                for (const r of resp.MetricDataResults ?? []) {
                    if (!r.Id) continue;
                    const timestamps = r.Timestamps ?? [];
                    const values = r.Values ?? [];
                    out.set(
                        r.Id,
                        timestamps.map((t, i) => ({ t: t.getTime(), v: values[i] })).filter((p) => p.v != null)
                    );
                }
                break;
            } catch (err) {
                attempt += 1;
                if (attempt > 3) {
                    log.warn('GetMetricData failed after retries — enrichment skipped for this batch', { error: String(err) });
                    break;
                }
                await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
            }
        }
    }
    return out;
}

export interface EnrichableEvent {
    scope: 'asg' | 'ecs';
    clusterName?: string;
    serviceName?: string;
    asgName?: string;
    startedAt: Date;
    /** When the activity completed, if known — the cutoff for the "after"
     *  lookup. Falls back to startedAt when absent (most ECS aws_api rows). */
    endedAt?: Date;
    /** Only fetched when the caller couldn't already derive it from the
     *  activity's own Cause/Description text. */
    needsDesiredBefore: boolean;
    /** Same idea as needsDesiredBefore, for the resulting count. Optional and
     *  defaults to no-op — existing callers that only ever wanted "before"
     *  are unaffected. The caller is responsible for only setting this true
     *  on events that actually resulted in a real capacity change (not e.g.
     *  scalingType 'not_scaled') — this function has no opinion on that, it
     *  just answers "what did the metric read after this timestamp" for
     *  whatever it's asked about. */
    needsDesiredAfter?: boolean;
}

export interface ScalingEnrichment {
    desiredBefore?: number;
    desiredAfter?: number;
    peakCpuBeforeScale?: number;
    peakMemoryBeforeScale?: number;
}

/**
 * Batched CloudWatch enrichment for a set of scaling events about to be
 * inserted. Returns a map keyed by the input array's index — never throws, so
 * a CloudWatch outage or a resource with no published metrics must not block
 * the compliance record itself.
 *
 * One query per (resource, metric) rather than per event: several events for
 * the same service in one poll batch share a single time series, and each
 * event then reads its own point out of it (the first datapoint at or before
 * its own startedAt) — GetMetricData's StartTime/EndTime apply to the whole
 * call, not per query, so a shared series covering the widest window needed is
 * correct and cheaper than one query per event.
 */
export async function fetchScalingEnrichment(
    events: EnrichableEvent[],
    assumed: AssumedCredentials,
    region: string
): Promise<Map<number, ScalingEnrichment>> {
    const results = new Map<number, ScalingEnrichment>();
    if (!events.length) return results;

    const resourceKey = (e: EnrichableEvent) => (e.scope === 'ecs' ? `ecs|${e.clusterName}|${e.serviceName}` : `asg|${e.asgName}`);
    const byResource = new Map<string, number[]>();
    events.forEach((e, idx) => {
        if (e.scope === 'ecs' && !(e.clusterName && e.serviceName)) return;
        if (e.scope === 'asg' && !e.asgName) return;
        const key = resourceKey(e);
        if (!byResource.has(key)) byResource.set(key, []);
        byResource.get(key)!.push(idx);
    });
    if (!byResource.size) return results;

    const queries: MetricDataQuery[] = [];
    const queryMeta = new Map<string, { indices: number[]; metric: 'desired' | 'cpu' | 'mem' }>();
    let qn = 0;
    let minStart = events[0].startedAt;
    let maxEnd = events[0].startedAt;
    // Widest "after" cutoff across events that need one — the query window's
    // end must reach past this (see windowEnd below) or the metric simply has
    // no later datapoint to find, regardless of how the extraction runs.
    let maxAfterCutoff: Date | null = null;

    for (const indices of byResource.values()) {
        const sample = events[indices[0]];
        for (const i of indices) {
            if (events[i].startedAt < minStart) minStart = events[i].startedAt;
            if (events[i].startedAt > maxEnd) maxEnd = events[i].startedAt;
            if (events[i].needsDesiredAfter) {
                const cutoff = events[i].endedAt ?? events[i].startedAt;
                if (!maxAfterCutoff || cutoff > maxAfterCutoff) maxAfterCutoff = cutoff;
            }
        }
        const anyNeedsDesired = indices.some((i) => events[i].needsDesiredBefore || events[i].needsDesiredAfter);

        if (sample.scope === 'ecs') {
            const dims = [
                { Name: 'ClusterName', Value: sample.clusterName! },
                { Name: 'ServiceName', Value: sample.serviceName! },
            ];
            if (anyNeedsDesired) {
                const id = `q${qn++}`;
                queries.push({
                    Id: id,
                    ReturnData: true,
                    MetricStat: { Metric: { Namespace: 'ECS/ContainerInsights', MetricName: 'DesiredTaskCount', Dimensions: dims }, Period: 60, Stat: 'Maximum' },
                });
                queryMeta.set(id, { indices, metric: 'desired' });
            }
            const cpuId = `q${qn++}`;
            queries.push({
                Id: cpuId,
                ReturnData: true,
                MetricStat: { Metric: { Namespace: 'AWS/ECS', MetricName: 'CPUUtilization', Dimensions: dims }, Period: 60, Stat: 'Maximum' },
            });
            queryMeta.set(cpuId, { indices, metric: 'cpu' });
            const memId = `q${qn++}`;
            queries.push({
                Id: memId,
                ReturnData: true,
                MetricStat: { Metric: { Namespace: 'AWS/ECS', MetricName: 'MemoryUtilization', Dimensions: dims }, Period: 60, Stat: 'Maximum' },
            });
            queryMeta.set(memId, { indices, metric: 'mem' });
        } else {
            const cpuId = `q${qn++}`;
            queries.push({
                Id: cpuId,
                ReturnData: true,
                MetricStat: {
                    Metric: { Namespace: 'AWS/EC2', MetricName: 'CPUUtilization', Dimensions: [{ Name: 'AutoScalingGroupName', Value: sample.asgName! }] },
                    Period: 300,
                    Stat: 'Maximum',
                },
            });
            queryMeta.set(cpuId, { indices, metric: 'cpu' });
            // No generic ASG memory metric without a CWAgent install — left
            // unset, same as the AWS console would show for these instances.
        }
    }
    if (!queries.length) return results;

    // 30 min covers the DesiredTaskCount step-function lookback; peak CPU/Mem
    // only needs 15. Padding to the wider of the two keeps this to one call.
    const windowStart = new Date(minStart.getTime() - 30 * 60_000);
    // Only widened past maxEnd when some event actually needs an "after"
    // value — a plain before/peak-only enrichment keeps its original, tighter
    // window rather than paying for a wider CloudWatch query nobody asked for.
    const windowEnd = maxAfterCutoff
        ? new Date(Math.max(maxEnd.getTime(), maxAfterCutoff.getTime()) + 30 * 60_000)
        : maxEnd;
    const cw = buildClient(assumed, region);
    const series = await runQueries(cw, queries, windowStart, windowEnd);

    for (const [id, meta] of queryMeta) {
        const points = series.get(id); // sorted TimestampDescending
        if (!points?.length) continue;
        for (const idx of meta.indices) {
            const cutoff = events[idx].startedAt.getTime();
            const point = points.find((p) => p.t <= cutoff);
            const prev = results.get(idx) ?? {};
            if (point) {
                if (meta.metric === 'desired') prev.desiredBefore = Math.round(point.v);
                if (meta.metric === 'cpu') prev.peakCpuBeforeScale = point.v;
                if (meta.metric === 'mem') prev.peakMemoryBeforeScale = point.v;
            }
            // "After": the earliest datapoint at or past when the activity
            // completed — the opposite search direction from "before" above,
            // over this SAME already-fetched series (same metric/resource),
            // not a second query.
            if (meta.metric === 'desired' && events[idx].needsDesiredAfter) {
                const afterCutoff = (events[idx].endedAt ?? events[idx].startedAt).getTime();
                const afterPoint = [...points].reverse().find((p) => p.t >= afterCutoff);
                if (afterPoint) prev.desiredAfter = Math.round(afterPoint.v);
            }
            if (point || (meta.metric === 'desired' && events[idx].needsDesiredAfter)) results.set(idx, prev);
        }
    }

    return results;
}

// ── Hourly utilization (capacity-planning, SA-004) ──────────────────────────

export interface UtilizationResource {
    /** Caller's own identity for this resource — used only as a map key. */
    key: string;
    resourceType: 'ecs' | 'asg';
    clusterName?: string;
    serviceName?: string;
    asgName?: string;
}

export interface HourlyBucket {
    bucketStartUtc: Date;
    cpuAvg?: number;
    cpuMax?: number;
    memAvg?: number;
    memMax?: number;
}

/**
 * Hourly Average+Max CPU/Mem per resource over [startTime, endTime), keyed by
 * the caller's own `key`. Period=3600 makes CloudWatch do the hourly bucketing
 * itself — one datapoint per hour per stat comes back directly, no client-side
 * grouping needed. ASG has no generic memory metric without a CWAgent install,
 * so mem* stays unset for 'asg' resources, same as the AWS console would show.
 */
export async function fetchHourlyUtilization(
    resources: UtilizationResource[],
    assumed: AssumedCredentials,
    region: string,
    startTime: Date,
    endTime: Date
): Promise<Map<string, HourlyBucket[]>> {
    const result = new Map<string, HourlyBucket[]>();
    if (!resources.length || startTime >= endTime) return result;

    type UtilizationField = 'cpuAvg' | 'cpuMax' | 'memAvg' | 'memMax';
    const queries: MetricDataQuery[] = [];
    const queryMeta = new Map<string, { key: string; field: UtilizationField }>();
    let qn = 0;
    const push = (key: string, field: UtilizationField, namespace: string, metricName: string, dims: { Name: string; Value: string }[], stat: 'Average' | 'Maximum') => {
        const id = `u${qn++}`;
        queries.push({ Id: id, ReturnData: true, MetricStat: { Metric: { Namespace: namespace, MetricName: metricName, Dimensions: dims }, Period: 3600, Stat: stat } });
        queryMeta.set(id, { key, field });
    };

    for (const r of resources) {
        if (r.resourceType === 'ecs') {
            if (!r.clusterName || !r.serviceName) continue;
            const dims = [{ Name: 'ClusterName', Value: r.clusterName }, { Name: 'ServiceName', Value: r.serviceName }];
            push(r.key, 'cpuAvg', 'AWS/ECS', 'CPUUtilization', dims, 'Average');
            push(r.key, 'cpuMax', 'AWS/ECS', 'CPUUtilization', dims, 'Maximum');
            push(r.key, 'memAvg', 'AWS/ECS', 'MemoryUtilization', dims, 'Average');
            push(r.key, 'memMax', 'AWS/ECS', 'MemoryUtilization', dims, 'Maximum');
        } else {
            if (!r.asgName) continue;
            const dims = [{ Name: 'AutoScalingGroupName', Value: r.asgName }];
            push(r.key, 'cpuAvg', 'AWS/EC2', 'CPUUtilization', dims, 'Average');
            push(r.key, 'cpuMax', 'AWS/EC2', 'CPUUtilization', dims, 'Maximum');
        }
    }
    if (!queries.length) return result;

    const cw = buildClient(assumed, region);
    const series = await runQueries(cw, queries, startTime, endTime);

    const byKey = new Map<string, Map<number, HourlyBucket>>();
    for (const [id, meta] of queryMeta) {
        const points = series.get(id);
        if (!points?.length) continue;
        let byBucket = byKey.get(meta.key);
        if (!byBucket) byKey.set(meta.key, (byBucket = new Map()));
        for (const p of points) {
            const bucket = byBucket.get(p.t) ?? { bucketStartUtc: new Date(p.t) };
            bucket[meta.field] = p.v;
            byBucket.set(p.t, bucket);
        }
    }
    for (const [key, byBucket] of byKey) {
        result.set(key, [...byBucket.values()].sort((a, b) => a.bucketStartUtc.getTime() - b.bucketStartUtc.getTime()));
    }
    return result;
}
