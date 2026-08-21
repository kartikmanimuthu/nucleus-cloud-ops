// workers/src/jobs/scaling-audit/services/network-cloudwatch-client.ts
//
// CloudWatch bandwidth + availability polling for Direct Connect connections
// and VPN tunnels (Scale Sentinel's Network Pulse capability). Self-contained
// rather than reusing lib/cloudwatch-client.ts's buildClient/runQueries —
// those are private to that file (not exported) — but mirrors its
// single-GetMetricData-call shape; this scope's resource counts (DX
// connections + VPN tunnels per account/region) are far below the
// 500-queries-per-call ceiling that file's chunking exists for.
//
// DX and VPN have genuinely different metric shapes, not just different
// dimensions:
//  - DX's ConnectionBpsIngress/Egress are already rates — Average and Maximum
//    both mean something within the hour, exactly like CPUUtilization.
//  - VPN's TunnelDataIn/Out are cumulative BYTE counters — CloudWatch's
//    per-period stat is a Sum, not a rate. At Period=3600 that Sum IS "the
//    hour's total", so bps = bytes*8/3600. There is no finer-grained "peak
//    within the hour" available at this resolution, so bpsMaxIn/Out equal
//    bpsAvgIn/Out for VPN tunnels — a genuine peak would need a second,
//    finer-period query this hourly-bucket model doesn't otherwise use
//    anywhere else, so it's left as a documented ceiling rather than a
//    silent approximation.
//
// Ingress and egress are kept as SEPARATE fields all the way through —
// never collapsed via Math.max() the way an earlier, removed version of this
// fetcher did. A link saturated on egress but idle on ingress (or vice
// versa) is a real, distinct failure mode a collapsed bpsAvg/bpsMax would
// hide from the compliance/ops record.
import { CloudWatchClient, GetMetricDataCommand, type MetricDataQuery } from '@aws-sdk/client-cloudwatch';
import { createLogger } from '../../../lib/logger.js';
import type { AssumedCredentials } from '../../discovery/types.js';

const log = createLogger('scaling-audit-network-cloudwatch-client');

export interface NetworkResourceRef {
    resourceType: 'dx_connection' | 'vpn_tunnel';
    resourceId: string; // connectionId, or `${vpnConnectionId}:${outsideIpAddress}`
    connectionId?: string; // dx only
    /** dx only — see network-client.ts's DxConnectionResource doc comment on
     *  why traffic is read from these, not from ConnectionId dimensions. */
    virtualInterfaceIds?: string[];
    vpnConnectionId?: string; // vpn only
    outsideIpAddress?: string; // vpn only
}

export interface NetworkHourlyBucket {
    bucketStartUtc: Date;
    bpsAvgIn?: number;
    bpsMaxIn?: number;
    bpsAvgOut?: number;
    bpsMaxOut?: number;
    /** Undefined when the state metric had no datapoint that hour (unknown,
     *  not necessarily up) — true only when the state metric's Minimum was 1
     *  for the whole hour. */
    stateUp?: boolean;
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

/** Runs one GetMetricData call and returns each query's datapoint series.
 *  Never throws — a CloudWatch outage degrades to "no series for any query in
 *  this batch", same posture as lib/cloudwatch-client.ts's runQueries(): a
 *  metric outage must never abort the rest of the scan. */
async function runQueries(cw: CloudWatchClient, queries: MetricDataQuery[], startTime: Date, endTime: Date): Promise<Map<string, SeriesPoint[]>> {
    const out = new Map<string, SeriesPoint[]>();
    try {
        const resp = await cw.send(
            new GetMetricDataCommand({ StartTime: startTime, EndTime: endTime, MetricDataQueries: queries, ScanBy: 'TimestampDescending' })
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
    } catch (err) {
        log.warn('GetMetricData failed — network utilization skipped for this poll', { error: String(err) });
    }
    return out;
}

const PERIOD_SECONDS = 3600;

type Field = 'bpsAvgIn' | 'bpsMaxIn' | 'bpsAvgOut' | 'bpsMaxOut' | 'bytesIn' | 'bytesOut' | 'stateMin';

/**
 * Hourly bandwidth (kept separate per direction — see header comment) and
 * up/down state for Direct Connect connections and VPN tunnels, for one
 * account/region.
 */
export async function fetchNetworkUtilization(
    assumed: AssumedCredentials,
    region: string,
    resources: NetworkResourceRef[],
    startTime: Date,
    endTime: Date
): Promise<Map<string, NetworkHourlyBucket[]>> {
    const result = new Map<string, NetworkHourlyBucket[]>();
    if (!resources.length || startTime >= endTime) return result;

    const queries: MetricDataQuery[] = [];
    const queryMeta = new Map<string, { key: string; field: Field }>();
    let qn = 0;
    const push = (
        key: string,
        field: Field,
        namespace: string,
        metricName: string,
        dims: { Name: string; Value: string }[],
        stat: 'Average' | 'Maximum' | 'Sum' | 'Minimum'
    ) => {
        const id = `n${qn++}`;
        queries.push({ Id: id, ReturnData: true, MetricStat: { Metric: { Namespace: namespace, MetricName: metricName, Dimensions: dims }, Period: PERIOD_SECONDS, Stat: stat } });
        queryMeta.set(id, { key, field });
    };

    for (const r of resources) {
        if (r.resourceType === 'dx_connection') {
            if (!r.connectionId) continue;
            const connDims = [{ Name: 'ConnectionId', Value: r.connectionId }];
            // ConnectionState is genuinely connection-level regardless of how
            // many VIFs ride it, so this is queried the same way either way.
            push(r.resourceId, 'stateMin', 'AWS/DX', 'ConnectionState', connDims, 'Minimum');

            if (r.virtualInterfaceIds?.length) {
                // Multiple VIFs on one connection each get their own query;
                // the accumulation step below sums same-bucket values across
                // them, so bpsAvg/MaxIn/Out end up as the connection's total
                // traffic across all its VIFs — an approximation for the max
                // fields (sum-of-per-VIF-hourly-maximums, not the combined
                // series' own maximum), same honesty-over-precision tradeoff
                // this file already makes for VPN's bpsMax==bpsAvg.
                for (const vifId of r.virtualInterfaceIds) {
                    // AWS publishes VirtualInterface*-level metrics under BOTH
                    // dimensions together, not VirtualInterfaceId alone — a
                    // GetMetricData query for a strict subset of a metric's
                    // actual dimension set matches nothing and returns an
                    // empty series, not an aggregate. Verified directly
                    // against a live connection: querying VirtualInterfaceId
                    // alone returned zero datapoints over a 7-day window;
                    // adding ConnectionId back returned real data immediately.
                    const vifDims = [
                        { Name: 'ConnectionId', Value: r.connectionId },
                        { Name: 'VirtualInterfaceId', Value: vifId },
                    ];
                    push(r.resourceId, 'bpsAvgIn', 'AWS/DX', 'VirtualInterfaceBpsIngress', vifDims, 'Average');
                    push(r.resourceId, 'bpsMaxIn', 'AWS/DX', 'VirtualInterfaceBpsIngress', vifDims, 'Maximum');
                    push(r.resourceId, 'bpsAvgOut', 'AWS/DX', 'VirtualInterfaceBpsEgress', vifDims, 'Average');
                    push(r.resourceId, 'bpsMaxOut', 'AWS/DX', 'VirtualInterfaceBpsEgress', vifDims, 'Maximum');
                }
            } else {
                // No VIF discovered for this connection — fall back to
                // Connection*-level metrics rather than reporting nothing.
                push(r.resourceId, 'bpsAvgIn', 'AWS/DX', 'ConnectionBpsIngress', connDims, 'Average');
                push(r.resourceId, 'bpsMaxIn', 'AWS/DX', 'ConnectionBpsIngress', connDims, 'Maximum');
                push(r.resourceId, 'bpsAvgOut', 'AWS/DX', 'ConnectionBpsEgress', connDims, 'Average');
                push(r.resourceId, 'bpsMaxOut', 'AWS/DX', 'ConnectionBpsEgress', connDims, 'Maximum');
            }
        } else {
            if (!r.vpnConnectionId || !r.outsideIpAddress) continue;
            const dims = [
                { Name: 'VpnId', Value: r.vpnConnectionId },
                { Name: 'TunnelIpAddress', Value: r.outsideIpAddress },
            ];
            push(r.resourceId, 'bytesIn', 'AWS/VPN', 'TunnelDataIn', dims, 'Sum');
            push(r.resourceId, 'bytesOut', 'AWS/VPN', 'TunnelDataOut', dims, 'Sum');
            push(r.resourceId, 'stateMin', 'AWS/VPN', 'TunnelState', dims, 'Minimum');
        }
    }
    if (!queries.length) return result;

    const cw = buildClient(assumed, region);
    const series = await runQueries(cw, queries, startTime, endTime);

    // Accumulate per (key, bucket timestamp) since each resource spans several
    // queries (one per field) that must be merged before the bucket can be
    // built. Summed rather than overwritten: a DX connection with multiple
    // VIFs pushes one query per VIF per field, all keyed to the same
    // connection resourceId, and their same-bucket values must add up to the
    // connection's total — every other resource type has exactly one query
    // per (key, field), where summing into an empty accumulator is identical
    // to the old overwrite behavior.
    const raw = new Map<string, Map<number, Partial<Record<Field, number>>>>();
    for (const [id, meta] of queryMeta) {
        const points = series.get(id);
        if (!points?.length) continue;
        let byBucket = raw.get(meta.key);
        if (!byBucket) raw.set(meta.key, (byBucket = new Map()));
        for (const p of points) {
            const fields = byBucket.get(p.t) ?? {};
            fields[meta.field] = (fields[meta.field] ?? 0) + p.v;
            byBucket.set(p.t, fields);
        }
    }

    for (const [key, byBucket] of raw) {
        const buckets: NetworkHourlyBucket[] = [...byBucket.entries()]
            .sort(([a], [b]) => a - b)
            .map(([t, f]) => {
                const isVpn = f.bytesIn !== undefined || f.bytesOut !== undefined;
                // VPN: convert the hour's byte Sum to bps; no finer-than-hourly
                // resolution exists, so max === avg (see header comment).
                const bpsIn = isVpn ? (f.bytesIn !== undefined ? (f.bytesIn * 8) / PERIOD_SECONDS : undefined) : f.bpsAvgIn;
                const bpsOut = isVpn ? (f.bytesOut !== undefined ? (f.bytesOut * 8) / PERIOD_SECONDS : undefined) : f.bpsAvgOut;
                return {
                    bucketStartUtc: new Date(t),
                    bpsAvgIn: bpsIn,
                    bpsMaxIn: isVpn ? bpsIn : f.bpsMaxIn,
                    bpsAvgOut: bpsOut,
                    bpsMaxOut: isVpn ? bpsOut : f.bpsMaxOut,
                    stateUp: f.stateMin === undefined ? undefined : f.stateMin === 1,
                };
            });
        result.set(key, buckets);
    }
    return result;
}
