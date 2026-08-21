import { describe, it, expect, vi, beforeEach } from 'vitest';

const send = vi.fn();
vi.mock('@aws-sdk/client-cloudwatch', () => ({
    CloudWatchClient: vi.fn().mockImplementation(() => ({ send })),
    GetMetricDataCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

import { fetchNetworkUtilization, type NetworkResourceRef } from './network-cloudwatch-client.js';

const ASSUMED = { credentials: { accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'ST' }, region: 'ap-south-1' };
const START = new Date('2026-08-17T00:00:00Z');
const END = new Date('2026-08-18T00:00:00Z');
const BUCKET = new Date('2026-08-17T10:00:00Z');

type Query = { Id: string; MetricStat: { Metric: { MetricName: string; Dimensions: Array<{ Name: string; Value: string }> }; Stat: string } };

function metricResult(id: string, points: Array<{ t: Date; v: number }>) {
    return { Id: id, Timestamps: points.map((p) => p.t), Values: points.map((p) => p.v) };
}

describe('fetchNetworkUtilization', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns an empty map and never calls CloudWatch when given no resources', async () => {
        const result = await fetchNetworkUtilization(ASSUMED, 'ap-south-1', [], START, END);
        expect(result.size).toBe(0);
        expect(send).not.toHaveBeenCalled();
    });

    it('returns an empty map when the window is empty (startTime >= endTime)', async () => {
        const result = await fetchNetworkUtilization(ASSUMED, 'ap-south-1', [{ resourceType: 'dx_connection', resourceId: 'dxcon-1', connectionId: 'dxcon-1' }], END, START);
        expect(result.size).toBe(0);
        expect(send).not.toHaveBeenCalled();
    });

    describe('Direct Connect (rate metrics — Average/Maximum both meaningful)', () => {
        it('keeps ingress and egress SEPARATE — never collapses via Math.max — when they genuinely differ', async () => {
            // Egress deliberately much larger than ingress: a collapsed bpsAvg/bpsMax
            // would silently report only the egress figure for BOTH directions.
            send.mockImplementation(async (cmd: { input: { MetricDataQueries: Query[] } }) => ({
                MetricDataResults: cmd.input.MetricDataQueries.map((q) => {
                    const name = q.MetricStat.Metric.MetricName;
                    const stat = q.MetricStat.Stat;
                    if (name === 'ConnectionBpsIngress' && stat === 'Average') return metricResult(q.Id, [{ t: BUCKET, v: 100 }]);
                    if (name === 'ConnectionBpsIngress' && stat === 'Maximum') return metricResult(q.Id, [{ t: BUCKET, v: 150 }]);
                    if (name === 'ConnectionBpsEgress' && stat === 'Average') return metricResult(q.Id, [{ t: BUCKET, v: 900 }]);
                    if (name === 'ConnectionBpsEgress' && stat === 'Maximum') return metricResult(q.Id, [{ t: BUCKET, v: 950 }]);
                    if (name === 'ConnectionState') return metricResult(q.Id, [{ t: BUCKET, v: 1 }]);
                    return metricResult(q.Id, []);
                }),
            }));

            const resources: NetworkResourceRef[] = [{ resourceType: 'dx_connection', resourceId: 'dxcon-1', connectionId: 'dxcon-1' }];
            const result = await fetchNetworkUtilization(ASSUMED, 'ap-south-1', resources, START, END);
            const buckets = result.get('dxcon-1');
            expect(buckets).toHaveLength(1);
            expect(buckets![0]).toEqual({
                bucketStartUtc: BUCKET,
                bpsAvgIn: 100,
                bpsMaxIn: 150,
                bpsAvgOut: 900,
                bpsMaxOut: 950,
                stateUp: true,
            });
        });

        it('queries AWS/DX with the ConnectionId dimension for every watched metric', async () => {
            send.mockResolvedValue({ MetricDataResults: [] });
            await fetchNetworkUtilization(ASSUMED, 'ap-south-1', [{ resourceType: 'dx_connection', resourceId: 'dxcon-1', connectionId: 'dxcon-1' }], START, END);

            const queries: Query[] = send.mock.calls[0][0].input.MetricDataQueries;
            expect(queries.length).toBeGreaterThan(0);
            const namespace = (q: any) => q.MetricStat.Metric.Namespace;
            expect(queries.every((q: any) => namespace(q) === 'AWS/DX')).toBe(true);
            expect(queries.some((q) => q.MetricStat.Metric.MetricName === 'ConnectionBpsIngress' && q.MetricStat.Stat === 'Average')).toBe(true);
            expect(queries.some((q) => q.MetricStat.Metric.MetricName === 'ConnectionBpsEgress' && q.MetricStat.Stat === 'Maximum')).toBe(true);
            expect(queries.some((q) => q.MetricStat.Metric.MetricName === 'ConnectionState' && q.MetricStat.Stat === 'Minimum')).toBe(true);
            expect(queries[0].MetricStat.Metric.Dimensions).toEqual([{ Name: 'ConnectionId', Value: 'dxcon-1' }]);
        });

        it('queries VirtualInterfaceId-dimensioned metrics instead of Connection*, when the connection has a VIF', async () => {
            // Regression: AWS only publishes real traffic under Connection*Bps*
            // for a connection with NO virtual interface at all. A connection
            // riding a transit/private/public VIF (the normal case) reports real
            // traffic under VirtualInterface*Bps* instead — querying Connection*
            // there reads a plausible-looking but wrong zero.
            send.mockResolvedValue({ MetricDataResults: [] });
            const resources: NetworkResourceRef[] = [
                { resourceType: 'dx_connection', resourceId: 'dxcon-1', connectionId: 'dxcon-1', virtualInterfaceIds: ['dxvif-1'] },
            ];
            await fetchNetworkUtilization(ASSUMED, 'ap-south-1', resources, START, END);

            const queries: Query[] = send.mock.calls[0][0].input.MetricDataQueries;
            expect(queries.some((q) => q.MetricStat.Metric.MetricName === 'ConnectionBpsIngress')).toBe(false);
            expect(queries.some((q) => q.MetricStat.Metric.MetricName === 'ConnectionBpsEgress')).toBe(false);
            const bpsQueries = queries.filter((q) => q.MetricStat.Metric.MetricName === 'VirtualInterfaceBpsIngress');
            expect(bpsQueries.length).toBeGreaterThan(0);
            // Both dimensions together — verified against a live connection
            // that VirtualInterfaceId alone matches nothing (see
            // network-cloudwatch-client.ts's comment on vifDims).
            expect(bpsQueries[0].MetricStat.Metric.Dimensions).toEqual([
                { Name: 'ConnectionId', Value: 'dxcon-1' },
                { Name: 'VirtualInterfaceId', Value: 'dxvif-1' },
            ]);
            // ConnectionState is genuinely connection-level regardless of VIFs.
            const stateQuery = queries.find((q) => q.MetricStat.Metric.MetricName === 'ConnectionState')!;
            expect(stateQuery.MetricStat.Metric.Dimensions).toEqual([{ Name: 'ConnectionId', Value: 'dxcon-1' }]);
        });

        it('sums bandwidth across multiple VIFs riding the same connection into one bucket', async () => {
            send.mockImplementation(async (cmd: { input: { MetricDataQueries: Query[] } }) => ({
                MetricDataResults: cmd.input.MetricDataQueries.map((q) => {
                    const name = q.MetricStat.Metric.MetricName;
                    const stat = q.MetricStat.Stat;
                    const vifId = q.MetricStat.Metric.Dimensions.find((d) => d.Name === 'VirtualInterfaceId')?.Value;
                    if (name === 'VirtualInterfaceBpsIngress' && stat === 'Average') {
                        return metricResult(q.Id, [{ t: BUCKET, v: vifId === 'dxvif-1' ? 100 : 40 }]);
                    }
                    if (name === 'VirtualInterfaceBpsEgress' && stat === 'Average') {
                        return metricResult(q.Id, [{ t: BUCKET, v: vifId === 'dxvif-1' ? 300 : 25 }]);
                    }
                    return metricResult(q.Id, []);
                }),
            }));
            const resources: NetworkResourceRef[] = [
                { resourceType: 'dx_connection', resourceId: 'dxcon-1', connectionId: 'dxcon-1', virtualInterfaceIds: ['dxvif-1', 'dxvif-2'] },
            ];
            const result = await fetchNetworkUtilization(ASSUMED, 'ap-south-1', resources, START, END);
            const bucket = result.get('dxcon-1')![0];
            expect(bucket.bpsAvgIn).toBe(140); // 100 + 40
            expect(bucket.bpsAvgOut).toBe(325); // 300 + 25
        });

        it('falls back to Connection*-level metrics when the connection has no discovered VIF', async () => {
            send.mockResolvedValue({ MetricDataResults: [] });
            await fetchNetworkUtilization(ASSUMED, 'ap-south-1', [{ resourceType: 'dx_connection', resourceId: 'dxcon-1', connectionId: 'dxcon-1', virtualInterfaceIds: [] }], START, END);
            const queries: Query[] = send.mock.calls[0][0].input.MetricDataQueries;
            expect(queries.some((q) => q.MetricStat.Metric.MetricName === 'ConnectionBpsIngress')).toBe(true);
            expect(queries.some((q) => q.MetricStat.Metric.MetricName === 'VirtualInterfaceBpsIngress')).toBe(false);
        });

        it('leaves stateUp undefined when the state metric has no datapoint that hour', async () => {
            send.mockImplementation(async (cmd: { input: { MetricDataQueries: Query[] } }) => ({
                MetricDataResults: cmd.input.MetricDataQueries.map((q) =>
                    q.MetricStat.Metric.MetricName === 'ConnectionState' ? metricResult(q.Id, []) : metricResult(q.Id, [{ t: BUCKET, v: 42 }])
                ),
            }));
            const result = await fetchNetworkUtilization(ASSUMED, 'ap-south-1', [{ resourceType: 'dx_connection', resourceId: 'dxcon-1', connectionId: 'dxcon-1' }], START, END);
            expect(result.get('dxcon-1')![0].stateUp).toBeUndefined();
        });

        it('reports stateUp=false when the Minimum state datapoint is not 1', async () => {
            send.mockImplementation(async (cmd: { input: { MetricDataQueries: Query[] } }) => ({
                MetricDataResults: cmd.input.MetricDataQueries.map((q) =>
                    q.MetricStat.Metric.MetricName === 'ConnectionState' ? metricResult(q.Id, [{ t: BUCKET, v: 0 }]) : metricResult(q.Id, [])
                ),
            }));
            const result = await fetchNetworkUtilization(ASSUMED, 'ap-south-1', [{ resourceType: 'dx_connection', resourceId: 'dxcon-1', connectionId: 'dxcon-1' }], START, END);
            expect(result.get('dxcon-1')![0].stateUp).toBe(false);
        });

        it('skips a DX resource with no connectionId, without calling CloudWatch for it', async () => {
            const result = await fetchNetworkUtilization(ASSUMED, 'ap-south-1', [{ resourceType: 'dx_connection', resourceId: 'dxcon-1' }], START, END);
            expect(result.size).toBe(0);
            expect(send).not.toHaveBeenCalled();
        });
    });

    describe('VPN tunnels (byte counters — Sum converted to bps; no finer-grained peak)', () => {
        it('converts the hourly byte Sum to bps (bytes*8/3600) and keeps in/out separate', async () => {
            send.mockImplementation(async (cmd: { input: { MetricDataQueries: Query[] } }) => ({
                MetricDataResults: cmd.input.MetricDataQueries.map((q) => {
                    const name = q.MetricStat.Metric.MetricName;
                    if (name === 'TunnelDataIn') return metricResult(q.Id, [{ t: BUCKET, v: 45_000 }]); // 45000*8/3600 = 100 bps
                    if (name === 'TunnelDataOut') return metricResult(q.Id, [{ t: BUCKET, v: 450_000 }]); // 450000*8/3600 = 1000 bps
                    if (name === 'TunnelState') return metricResult(q.Id, [{ t: BUCKET, v: 1 }]);
                    return metricResult(q.Id, []);
                }),
            }));

            const resources: NetworkResourceRef[] = [
                { resourceType: 'vpn_tunnel', resourceId: 'vpn-1:1.2.3.4', vpnConnectionId: 'vpn-1', outsideIpAddress: '1.2.3.4' },
            ];
            const result = await fetchNetworkUtilization(ASSUMED, 'ap-south-1', resources, START, END);
            const bucket = result.get('vpn-1:1.2.3.4')![0];
            expect(bucket.bpsAvgIn).toBe(100);
            expect(bucket.bpsAvgOut).toBe(1000);
            // Documented ceiling: no finer-than-hourly resolution, so max === avg for VPN.
            expect(bucket.bpsMaxIn).toBe(100);
            expect(bucket.bpsMaxOut).toBe(1000);
            expect(bucket.stateUp).toBe(true);
        });

        it('queries AWS/VPN with the (VpnId, TunnelIpAddress) dimension pair', async () => {
            send.mockResolvedValue({ MetricDataResults: [] });
            await fetchNetworkUtilization(
                ASSUMED,
                'ap-south-1',
                [{ resourceType: 'vpn_tunnel', resourceId: 'vpn-1:1.2.3.4', vpnConnectionId: 'vpn-1', outsideIpAddress: '1.2.3.4' }],
                START,
                END
            );
            const queries: Query[] = send.mock.calls[0][0].input.MetricDataQueries;
            const namespace = (q: any) => q.MetricStat.Metric.Namespace;
            expect(queries.every((q: any) => namespace(q) === 'AWS/VPN')).toBe(true);
            expect(queries[0].MetricStat.Metric.Dimensions).toEqual([
                { Name: 'VpnId', Value: 'vpn-1' },
                { Name: 'TunnelIpAddress', Value: '1.2.3.4' },
            ]);
            expect(queries.some((q) => q.MetricStat.Metric.MetricName === 'TunnelDataIn' && q.MetricStat.Stat === 'Sum')).toBe(true);
            expect(queries.some((q) => q.MetricStat.Metric.MetricName === 'TunnelDataOut' && q.MetricStat.Stat === 'Sum')).toBe(true);
        });

        it('skips a VPN resource missing vpnConnectionId or outsideIpAddress, without calling CloudWatch for it', async () => {
            const result = await fetchNetworkUtilization(ASSUMED, 'ap-south-1', [{ resourceType: 'vpn_tunnel', resourceId: 'vpn-1:' }], START, END);
            expect(result.size).toBe(0);
            expect(send).not.toHaveBeenCalled();
        });
    });

    it('mixes DX and VPN resources in one call, keyed independently by resourceId', async () => {
        send.mockImplementation(async (cmd: { input: { MetricDataQueries: Query[] } }) => ({
            MetricDataResults: cmd.input.MetricDataQueries.map((q) => {
                const name = q.MetricStat.Metric.MetricName;
                if (name === 'ConnectionBpsIngress' || name === 'ConnectionBpsEgress') return metricResult(q.Id, [{ t: BUCKET, v: 10 }]);
                if (name === 'TunnelDataIn' || name === 'TunnelDataOut') return metricResult(q.Id, [{ t: BUCKET, v: 3600 }]); // 8 bps
                return metricResult(q.Id, []);
            }),
        }));

        const resources: NetworkResourceRef[] = [
            { resourceType: 'dx_connection', resourceId: 'dxcon-1', connectionId: 'dxcon-1' },
            { resourceType: 'vpn_tunnel', resourceId: 'vpn-1:1.2.3.4', vpnConnectionId: 'vpn-1', outsideIpAddress: '1.2.3.4' },
        ];
        const result = await fetchNetworkUtilization(ASSUMED, 'ap-south-1', resources, START, END);
        expect(result.has('dxcon-1')).toBe(true);
        expect(result.has('vpn-1:1.2.3.4')).toBe(true);
        expect(result.get('dxcon-1')![0].bpsAvgIn).toBe(10);
        expect(result.get('vpn-1:1.2.3.4')![0].bpsAvgIn).toBe(8);
    });

    it('never throws when CloudWatch fails — returns an empty map for that resource instead', async () => {
        send.mockRejectedValue(new Error('boom'));
        const result = await fetchNetworkUtilization(
            ASSUMED,
            'ap-south-1',
            [{ resourceType: 'dx_connection', resourceId: 'dxcon-1', connectionId: 'dxcon-1' }],
            START,
            END
        );
        expect(result.size).toBe(0);
    });
});
