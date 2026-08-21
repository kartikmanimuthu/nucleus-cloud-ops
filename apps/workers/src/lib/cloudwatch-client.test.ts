import { describe, it, expect, vi, beforeEach } from 'vitest';

const send = vi.fn();
vi.mock('@aws-sdk/client-cloudwatch', () => ({
    CloudWatchClient: vi.fn().mockImplementation(() => ({ send })),
    GetMetricDataCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

import { fetchScalingEnrichment, fetchHourlyUtilization, type EnrichableEvent, type UtilizationResource } from './cloudwatch-client.js';

const ASSUMED = { credentials: { accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'ST' }, region: 'ap-south-1' };

function metricResult(id: string, points: Array<{ t: Date; v: number }>) {
    return { Id: id, Timestamps: points.map((p) => p.t), Values: points.map((p) => p.v) };
}

describe('fetchScalingEnrichment', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns empty when given no events, without calling CloudWatch', async () => {
        const result = await fetchScalingEnrichment([], ASSUMED, 'ap-south-1');
        expect(result.size).toBe(0);
        expect(send).not.toHaveBeenCalled();
    });

    it('fills desiredBefore from the datapoint at-or-before startedAt, and always fills peak CPU/Mem', async () => {
        const startedAt = new Date('2026-08-01T10:00:00Z');
        const events: EnrichableEvent[] = [
            { scope: 'ecs', clusterName: 'my-cluster', serviceName: 'my-svc', startedAt, needsDesiredBefore: true },
        ];

        send.mockImplementation(async (cmd: { input: { MetricDataQueries: Array<{ Id: string }> } }) => ({
            MetricDataResults: cmd.input.MetricDataQueries.map((q) => {
                if (q.Id === 'q0') return metricResult('q0', [{ t: new Date('2026-08-01T09:58:00Z'), v: 2 }]);
                if (q.Id === 'q1') return metricResult('q1', [{ t: new Date('2026-08-01T09:59:00Z'), v: 87.5 }]);
                return metricResult('q2', [{ t: new Date('2026-08-01T09:59:00Z'), v: 42.1 }]);
            }),
        }));

        const result = await fetchScalingEnrichment(events, ASSUMED, 'ap-south-1');
        expect(result.get(0)).toEqual({ desiredBefore: 2, peakCpuBeforeScale: 87.5, peakMemoryBeforeScale: 42.1 });
    });

    it('skips desiredBefore lookup when the event already has it, but still fetches peak CPU/Mem', async () => {
        const startedAt = new Date('2026-08-01T10:00:00Z');
        const events: EnrichableEvent[] = [
            { scope: 'ecs', clusterName: 'c', serviceName: 's', startedAt, needsDesiredBefore: false },
        ];
        send.mockImplementation(async (cmd: { input: { MetricDataQueries: Array<{ Id: string; MetricStat: { Metric: { MetricName: string } } }> } }) => {
            // No DesiredTaskCount query should have been built at all.
            expect(cmd.input.MetricDataQueries.some((q: any) => q.MetricStat.Metric.MetricName === 'DesiredTaskCount')).toBe(false);
            return { MetricDataResults: cmd.input.MetricDataQueries.map((q) => metricResult(q.Id, [{ t: startedAt, v: 50 }])) };
        });

        const result = await fetchScalingEnrichment(events, ASSUMED, 'ap-south-1');
        expect(result.get(0)?.desiredBefore).toBeUndefined();
        expect(result.get(0)?.peakCpuBeforeScale).toBe(50);
    });

    it('leaves a resource unset when CloudWatch has no datapoint in the window (metric miss, not an error)', async () => {
        const events: EnrichableEvent[] = [
            { scope: 'ecs', clusterName: 'c', serviceName: 's', startedAt: new Date(), needsDesiredBefore: true },
        ];
        send.mockResolvedValue({ MetricDataResults: [] });

        const result = await fetchScalingEnrichment(events, ASSUMED, 'ap-south-1');
        expect(result.get(0)).toBeUndefined();
    });

    it('never throws when CloudWatch itself fails — enrichment is best-effort', async () => {
        const events: EnrichableEvent[] = [
            { scope: 'ecs', clusterName: 'c', serviceName: 's', startedAt: new Date(), needsDesiredBefore: true },
        ];
        send.mockRejectedValue(new Error('ThrottlingException'));

        await expect(fetchScalingEnrichment(events, ASSUMED, 'ap-south-1')).resolves.toBeInstanceOf(Map);
    }, 10_000);

    it('groups multiple events for the same resource into one query, each reading its own point from the shared series', async () => {
        const earlier = new Date('2026-08-01T08:00:00Z');
        const later = new Date('2026-08-01T10:00:00Z');
        const events: EnrichableEvent[] = [
            { scope: 'ecs', clusterName: 'c', serviceName: 's', startedAt: earlier, needsDesiredBefore: false },
            { scope: 'ecs', clusterName: 'c', serviceName: 's', startedAt: later, needsDesiredBefore: false },
        ];

        let callCount = 0;
        send.mockImplementation(async (cmd: { input: { MetricDataQueries: unknown[] } }) => {
            callCount += 1;
            // Same resource, same metrics — must not duplicate queries per event.
            expect(cmd.input.MetricDataQueries.length).toBe(2); // cpu + mem, once each
            return {
                MetricDataResults: [
                    metricResult('q0', [
                        { t: later, v: 90 },
                        { t: earlier, v: 10 },
                    ]),
                    metricResult('q1', [
                        { t: later, v: 91 },
                        { t: earlier, v: 11 },
                    ]),
                ],
            };
        });

        const result = await fetchScalingEnrichment(events, ASSUMED, 'ap-south-1');
        expect(callCount).toBe(1);
        expect(result.get(0)?.peakCpuBeforeScale).toBe(10); // earlier event reads the earlier point
        expect(result.get(1)?.peakCpuBeforeScale).toBe(90); // later event reads the later point
    });

    it('for ASG scope, queries AWS/EC2 CPUUtilization by AutoScalingGroupName and never requests memory', async () => {
        const startedAt = new Date();
        const events: EnrichableEvent[] = [
            { scope: 'asg', asgName: 'my-asg', startedAt, needsDesiredBefore: false },
        ];
        send.mockImplementation(async (cmd: { input: { MetricDataQueries: Array<{ Id: string; MetricStat: { Metric: { Namespace: string; MetricName: string; Dimensions: Array<{ Name: string; Value: string }> } } }> } }) => {
            expect(cmd.input.MetricDataQueries).toHaveLength(1);
            const q = cmd.input.MetricDataQueries[0];
            expect(q.MetricStat.Metric.Namespace).toBe('AWS/EC2');
            expect(q.MetricStat.Metric.MetricName).toBe('CPUUtilization');
            expect(q.MetricStat.Metric.Dimensions).toEqual([{ Name: 'AutoScalingGroupName', Value: 'my-asg' }]);
            return { MetricDataResults: [metricResult(q.Id, [{ t: startedAt, v: 33 }])] };
        });

        const result = await fetchScalingEnrichment(events, ASSUMED, 'ap-south-1');
        expect(result.get(0)).toEqual({ peakCpuBeforeScale: 33 });
    });

    // ── desiredAfter: the opposite-direction search, for scheduled actions
    // whose Cause/Description only ever mentions min/max bounds ("Setting min
    // capacity to 4 and max capacity to 10"), never the resulting desired
    // count — see index.ts's enrichBeforeInsert doc comment.
    describe('desiredAfter (the resulting count, for activities whose own text omits it)', () => {
        it('fills desiredAfter from the earliest datapoint at-or-after endedAt', async () => {
            const startedAt = new Date('2026-08-01T10:00:00Z');
            const endedAt = new Date('2026-08-01T10:02:00Z');
            const events: EnrichableEvent[] = [
                { scope: 'ecs', clusterName: 'c', serviceName: 's', startedAt, endedAt, needsDesiredBefore: false, needsDesiredAfter: true },
            ];

            send.mockImplementation(async (cmd: { input: { MetricDataQueries: Array<{ Id: string; MetricStat: { Metric: { MetricName: string } } }> } }) => ({
                MetricDataResults: cmd.input.MetricDataQueries.map((q) => {
                    if (q.MetricStat.Metric.MetricName === 'DesiredTaskCount') {
                        // Descending, as the real API returns — one point before
                        // startedAt (must be ignored), two at/after endedAt (the
                        // EARLIEST of those two is the right answer, not the latest).
                        return metricResult(q.Id, [
                            { t: new Date('2026-08-01T10:05:00Z'), v: 10 },
                            { t: new Date('2026-08-01T10:03:00Z'), v: 4 },
                            { t: new Date('2026-08-01T09:58:00Z'), v: 1 },
                        ]);
                    }
                    return metricResult(q.Id, []);
                }),
            }));

            const result = await fetchScalingEnrichment(events, ASSUMED, 'ap-south-1');
            expect(result.get(0)?.desiredAfter).toBe(4);
        });

        it('falls back to startedAt as the after-cutoff when endedAt is absent', async () => {
            const startedAt = new Date('2026-08-01T10:00:00Z');
            const events: EnrichableEvent[] = [
                { scope: 'ecs', clusterName: 'c', serviceName: 's', startedAt, needsDesiredBefore: false, needsDesiredAfter: true },
            ];

            send.mockImplementation(async (cmd: { input: { MetricDataQueries: Array<{ Id: string; MetricStat: { Metric: { MetricName: string } } }> } }) => ({
                MetricDataResults: cmd.input.MetricDataQueries.map((q) =>
                    q.MetricStat.Metric.MetricName === 'DesiredTaskCount'
                        ? metricResult(q.Id, [{ t: new Date('2026-08-01T10:01:00Z'), v: 6 }])
                        : metricResult(q.Id, [])
                ),
            }));

            const result = await fetchScalingEnrichment(events, ASSUMED, 'ap-south-1');
            expect(result.get(0)?.desiredAfter).toBe(6);
        });

        it('does not set desiredAfter when needsDesiredAfter is not requested — default no-op', async () => {
            const startedAt = new Date('2026-08-01T10:00:00Z');
            const events: EnrichableEvent[] = [
                { scope: 'ecs', clusterName: 'c', serviceName: 's', startedAt, needsDesiredBefore: true },
            ];
            send.mockResolvedValue({
                MetricDataResults: [
                    metricResult('q0', [{ t: startedAt, v: 3 }]),
                    metricResult('q1', [{ t: startedAt, v: 20 }]),
                    metricResult('q2', [{ t: startedAt, v: 30 }]),
                ],
            });

            const result = await fetchScalingEnrichment(events, ASSUMED, 'ap-south-1');
            expect(result.get(0)?.desiredBefore).toBe(3);
            expect(result.get(0)?.desiredAfter).toBeUndefined();
        });

        it('fills both desiredBefore and desiredAfter from one shared DesiredTaskCount series — not a duplicate query', async () => {
            const startedAt = new Date('2026-08-01T10:00:00Z');
            const endedAt = new Date('2026-08-01T10:02:00Z');
            const events: EnrichableEvent[] = [
                { scope: 'ecs', clusterName: 'c', serviceName: 's', startedAt, endedAt, needsDesiredBefore: true, needsDesiredAfter: true },
            ];

            let desiredQueryCount = 0;
            send.mockImplementation(async (cmd: { input: { MetricDataQueries: Array<{ Id: string; MetricStat: { Metric: { MetricName: string } } }> } }) => {
                desiredQueryCount += cmd.input.MetricDataQueries.filter((q) => q.MetricStat.Metric.MetricName === 'DesiredTaskCount').length;
                return {
                    MetricDataResults: cmd.input.MetricDataQueries.map((q) =>
                        q.MetricStat.Metric.MetricName === 'DesiredTaskCount'
                            ? metricResult(q.Id, [
                                  { t: new Date('2026-08-01T10:03:00Z'), v: 4 },
                                  { t: new Date('2026-08-01T09:58:00Z'), v: 1 },
                              ])
                            : metricResult(q.Id, [])
                    ),
                };
            });

            const result = await fetchScalingEnrichment(events, ASSUMED, 'ap-south-1');
            expect(desiredQueryCount).toBe(1);
            expect(result.get(0)?.desiredBefore).toBe(1);
            expect(result.get(0)?.desiredAfter).toBe(4);
        });
    });
});

describe('fetchHourlyUtilization', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns empty when given no resources, without calling CloudWatch', async () => {
        const result = await fetchHourlyUtilization([], ASSUMED, 'ap-south-1', new Date(0), new Date(1));
        expect(result.size).toBe(0);
        expect(send).not.toHaveBeenCalled();
    });

    it('fetches 4 queries for an ECS resource (cpu/mem x avg/max) and assembles one bucket per hour', async () => {
        const start = new Date('2026-08-01T00:00:00Z');
        const end = new Date('2026-08-01T02:00:00Z');
        const resources: UtilizationResource[] = [{ key: 'ecs|svc1', resourceType: 'ecs', clusterName: 'c', serviceName: 'svc1' }];

        send.mockImplementation(async (cmd: { input: { MetricDataQueries: Array<{ Id: string; MetricStat: { Metric: { MetricName: string }; Stat: string } }> } }) => {
            expect(cmd.input.MetricDataQueries).toHaveLength(4);
            return {
                MetricDataResults: cmd.input.MetricDataQueries.map((q) => {
                    const isCpu = q.MetricStat.Metric.MetricName === 'CPUUtilization';
                    const isAvg = q.MetricStat.Stat === 'Average';
                    const v0 = isCpu ? (isAvg ? 10 : 20) : isAvg ? 30 : 40;
                    return {
                        Id: q.Id,
                        Timestamps: [new Date('2026-08-01T00:00:00Z'), new Date('2026-08-01T01:00:00Z')],
                        Values: [v0, v0 + 1],
                    };
                }),
            };
        });

        const result = await fetchHourlyUtilization(resources, ASSUMED, 'ap-south-1', start, end);
        const buckets = result.get('ecs|svc1');
        expect(buckets).toHaveLength(2);
        expect(buckets?.[0]).toEqual({ bucketStartUtc: new Date('2026-08-01T00:00:00Z'), cpuAvg: 10, cpuMax: 20, memAvg: 30, memMax: 40 });
        expect(buckets?.[1]).toEqual({ bucketStartUtc: new Date('2026-08-01T01:00:00Z'), cpuAvg: 11, cpuMax: 21, memAvg: 31, memMax: 41 });
    });

    it('fetches only 2 queries (cpu avg/max) for an ASG resource — no memory metric', async () => {
        const resources: UtilizationResource[] = [{ key: 'asg|my-asg', resourceType: 'asg', asgName: 'my-asg' }];
        send.mockImplementation(async (cmd: { input: { MetricDataQueries: Array<{ Id: string; MetricStat: { Metric: { Namespace: string; Dimensions: Array<{ Name: string; Value: string }> } } }> } }) => {
            expect(cmd.input.MetricDataQueries).toHaveLength(2);
            expect(cmd.input.MetricDataQueries[0].MetricStat.Metric.Namespace).toBe('AWS/EC2');
            expect(cmd.input.MetricDataQueries[0].MetricStat.Metric.Dimensions).toEqual([{ Name: 'AutoScalingGroupName', Value: 'my-asg' }]);
            return { MetricDataResults: cmd.input.MetricDataQueries.map((q) => ({ Id: q.Id, Timestamps: [new Date('2026-08-01T00:00:00Z')], Values: [15] })) };
        });

        const result = await fetchHourlyUtilization(resources, ASSUMED, 'ap-south-1', new Date('2026-08-01T00:00:00Z'), new Date('2026-08-01T01:00:00Z'));
        expect(result.get('asg|my-asg')).toEqual([{ bucketStartUtc: new Date('2026-08-01T00:00:00Z'), cpuAvg: 15, cpuMax: 15 }]);
    });

    it('skips a resource missing its required dimension instead of throwing', async () => {
        const resources: UtilizationResource[] = [{ key: 'ecs|incomplete', resourceType: 'ecs', clusterName: 'c' }]; // no serviceName
        const result = await fetchHourlyUtilization(resources, ASSUMED, 'ap-south-1', new Date('2026-08-01T00:00:00Z'), new Date('2026-08-01T01:00:00Z'));
        expect(result.size).toBe(0);
        expect(send).not.toHaveBeenCalled();
    });
});
