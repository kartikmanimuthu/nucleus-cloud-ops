import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/pg-config', () => ({ getTenantClient: vi.fn() }));

import { getTenantClient } from '@/lib/db/pg-config';
import { ScalingAuditPostgresRepository } from './postgres';

const repo = new ScalingAuditPostgresRepository();

function makeEventRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 'evt-1', tenantId: 'tenant-1', accountId: 'acc-1', region: 'us-east-1',
        scope: 'ecs', source: 'cloudtrail', activityId: 'act-1', resourceId: 'res-1',
        asgName: null, clusterName: 'cluster-1', serviceName: 'svc-1', scalableDimension: null,
        inventoryMatched: true, scalingType: 'scale_out', policyName: null, scheduledActionName: null,
        alarmName: null, notScaledCode: null, cause: 'CPU high', description: null,
        statusCode: 'Successful', statusMessage: null, notScaledReasons: null, rawPayload: null,
        desiredBefore: 2, desiredAfter: 4, minBefore: 1, maxBefore: 10, minAfter: 1, maxAfter: 10,
        capacityDelta: 2, desiredBeforeSource: 'activity', peakCpuBeforeScale: 85, peakMemoryBeforeScale: 60,
        actor: 'aws-autoscaling', actorType: 'system', initiatedBy: null, correlationId: null,
        startedAt: new Date('2026-02-01T00:00:00Z'), endedAt: new Date('2026-02-01T00:01:00Z'),
        durationSeconds: 60, reportDateIst: new Date('2026-02-01T00:00:00Z'),
        capturedByRunId: 'run-1', capturedAt: new Date('2026-02-01T00:02:00Z'),
        ...overrides,
    };
}

function makeDb(overrides: Record<string, any> = {}) {
    return {
        scalingEvent: { count: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), groupBy: vi.fn() },
        scalingAuditWatermark: { count: vi.fn(), findMany: vi.fn() },
        scalingAuditRun: { findFirst: vi.fn(), count: vi.fn(), findMany: vi.fn() },
        scalingPolicySnapshot: { findMany: vi.fn() },
        scalingAuditDailySeal: { findFirst: vi.fn() },
        ...overrides,
    };
}

beforeEach(() => vi.clearAllMocks());

describe('listEvents', () => {
    it('scopes by tenant and transforms rows, including the effect-filter predicate by default', async () => {
        const db = makeDb({ scalingEvent: { count: vi.fn().mockResolvedValue(1), findMany: vi.fn().mockResolvedValue([makeEventRow()]) } });
        vi.mocked(getTenantClient).mockReturnValue(db as any);

        const result = await repo.listEvents({ tenantId: 'tenant-1' } as any);

        expect(getTenantClient).toHaveBeenCalledWith('tenant-1');
        const [{ where }] = db.scalingEvent.count.mock.calls[0];
        expect(where.tenantId).toBe('tenant-1');
        expect(where.AND).toBeDefined(); // capacity-change predicate applied by default
        expect(result.total).toBe(1);
        expect(result.events[0]).toEqual(expect.objectContaining({ id: 'evt-1', reportDateIst: '2026-02-01' }));
    });

    it('skips the capacity-change predicate when effect is "all"', async () => {
        const db = makeDb({ scalingEvent: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) } });
        vi.mocked(getTenantClient).mockReturnValue(db as any);

        await repo.listEvents({ tenantId: 'tenant-1', effect: 'all' } as any);
        const [{ where }] = db.scalingEvent.count.mock.calls[0];
        expect(where.AND).toBeUndefined();
    });

    it('builds a case-insensitive OR search across resource/asg/service/cluster/cause', async () => {
        const db = makeDb({ scalingEvent: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) } });
        vi.mocked(getTenantClient).mockReturnValue(db as any);

        await repo.listEvents({ tenantId: 'tenant-1', searchTerm: '  i-123  ' } as any);
        const [{ where }] = db.scalingEvent.count.mock.calls[0];
        expect(where.OR).toEqual(expect.arrayContaining([{ resourceId: { contains: 'i-123', mode: 'insensitive' } }]));
    });

    it('applies excludeScalingTypes only when scalingType is not explicitly set', async () => {
        const db = makeDb({ scalingEvent: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) } });
        vi.mocked(getTenantClient).mockReturnValue(db as any);

        await repo.listEvents({ tenantId: 'tenant-1', excludeScalingTypes: ['not_scaled'] } as any);
        expect(db.scalingEvent.count.mock.calls[0][0].where.scalingType).toEqual({ notIn: ['not_scaled'] });

        await repo.listEvents({ tenantId: 'tenant-1', scalingType: 'scale_out', excludeScalingTypes: ['not_scaled'] } as any);
        expect(db.scalingEvent.count.mock.calls[1][0].where.scalingType).toBe('scale_out');
    });
});

describe('listResources', () => {
    it('sorts groups by most-recently-active and paginates', async () => {
        const db = makeDb({
            scalingEvent: {
                groupBy: vi.fn().mockResolvedValue([
                    { resourceId: 'r1', scope: 'ecs', accountId: 'a1', region: 'us-east-1', asgName: null, clusterName: null, serviceName: 'svc-1', _count: { _all: 5 }, _min: { startedAt: new Date('2026-01-01') }, _max: { startedAt: new Date('2026-02-01') } },
                    { resourceId: 'r2', scope: 'asg', accountId: 'a1', region: 'us-east-1', asgName: 'asg-1', clusterName: null, serviceName: null, _count: { _all: 2 }, _min: { startedAt: new Date('2026-01-05') }, _max: { startedAt: new Date('2026-02-10') } },
                ]),
            },
        });
        vi.mocked(getTenantClient).mockReturnValue(db as any);

        const result = await repo.listResources({ tenantId: 'tenant-1', page: 1, limit: 1 } as any);
        expect(result.total).toBe(2);
        expect(result.resources).toHaveLength(1);
        expect(result.resources[0].resourceId).toBe('r2'); // most recently active
        expect(result.resources[0].displayName).toBe('asg-1');
    });

    it('falls back to resourceId as displayName when no friendly name is set', async () => {
        const db = makeDb({
            scalingEvent: {
                groupBy: vi.fn().mockResolvedValue([
                    { resourceId: 'r1', scope: 'ecs', accountId: 'a1', region: 'us-east-1', asgName: null, clusterName: null, serviceName: null, _count: { _all: 1 }, _min: { startedAt: new Date() }, _max: { startedAt: new Date() } },
                ]),
            },
        });
        vi.mocked(getTenantClient).mockReturnValue(db as any);

        const result = await repo.listResources({ tenantId: 'tenant-1' } as any);
        expect(result.resources[0].displayName).toBe('r1');
    });
});

describe('getEvent', () => {
    it('scopes by both id and tenantId', async () => {
        const db = makeDb({ scalingEvent: { findFirst: vi.fn().mockResolvedValue(makeEventRow()) } });
        vi.mocked(getTenantClient).mockReturnValue(db as any);

        const result = await repo.getEvent('evt-1', 'tenant-1');
        expect(db.scalingEvent.findFirst).toHaveBeenCalledWith({ where: { id: 'evt-1', tenantId: 'tenant-1' } });
        expect(result?.id).toBe('evt-1');
    });

    it('returns null when not found', async () => {
        const db = makeDb({ scalingEvent: { findFirst: vi.fn().mockResolvedValue(null) } });
        vi.mocked(getTenantClient).mockReturnValue(db as any);
        expect(await repo.getEvent('missing', 'tenant-1')).toBeNull();
    });
});

describe('listAllEvents', () => {
    it('caps at maxRows and scopes by tenant', async () => {
        const db = makeDb({ scalingEvent: { findMany: vi.fn().mockResolvedValue([makeEventRow()]) } });
        vi.mocked(getTenantClient).mockReturnValue(db as any);

        const result = await repo.listAllEvents({ tenantId: 'tenant-1' } as any, 50001);
        expect(db.scalingEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 50001 }));
        expect(result).toHaveLength(1);
    });
});

describe('getSummary', () => {
    it('aggregates counts by scalingType/scope/source and the latest run', async () => {
        const db = makeDb({
            scalingEvent: {
                count: vi.fn().mockResolvedValue(10),
                groupBy: vi.fn()
                    .mockResolvedValueOnce([{ scalingType: 'scale_out', _count: { _all: 6 } }])
                    .mockResolvedValueOnce([{ scope: 'ecs', _count: { _all: 10 } }])
                    .mockResolvedValueOnce([{ source: 'cloudtrail', _count: { _all: 10 } }]),
            },
            scalingAuditWatermark: { count: vi.fn().mockResolvedValue(2) },
            scalingAuditRun: { findFirst: vi.fn().mockResolvedValue({ startedAt: new Date('2026-02-10T00:00:00Z'), status: 'completed' }) },
        });
        vi.mocked(getTenantClient).mockReturnValue(db as any);

        const result = await repo.getSummary('tenant-1');
        expect(result).toEqual({
            totalEvents: 10, byScalingType: { scale_out: 6 }, byScope: { ecs: 10 }, bySource: { cloudtrail: 10 },
            openGaps: 2, lastRunAt: '2026-02-10T00:00:00.000Z', lastRunStatus: 'completed',
        });
    });

    it('reports null lastRun fields when no run has ever executed', async () => {
        const db = makeDb({
            scalingEvent: { count: vi.fn().mockResolvedValue(0), groupBy: vi.fn().mockResolvedValue([]) },
            scalingAuditWatermark: { count: vi.fn().mockResolvedValue(0) },
            scalingAuditRun: { findFirst: vi.fn().mockResolvedValue(null) },
        });
        vi.mocked(getTenantClient).mockReturnValue(db as any);

        const result = await repo.getSummary('tenant-1');
        expect(result.lastRunAt).toBeNull();
        expect(result.lastRunStatus).toBeNull();
    });
});

describe('getFacets', () => {
    it('returns distinct accountIds/regions/scalingTypes', async () => {
        const db = makeDb({
            scalingEvent: {
                groupBy: vi.fn()
                    .mockResolvedValueOnce([{ accountId: 'a1' }, { accountId: 'a2' }])
                    .mockResolvedValueOnce([{ region: 'us-east-1' }])
                    .mockResolvedValueOnce([{ scalingType: 'scale_out' }, { scalingType: 'scale_in' }]),
            },
        });
        vi.mocked(getTenantClient).mockReturnValue(db as any);

        const result = await repo.getFacets('tenant-1');
        expect(result).toEqual({ accountIds: ['a1', 'a2'], regions: ['us-east-1'], scalingTypes: ['scale_out', 'scale_in'] });
    });
});

describe('listRuns', () => {
    it('paginates runs and defaults non-array errors to []', async () => {
        const db = makeDb({
            scalingAuditRun: {
                count: vi.fn().mockResolvedValue(1),
                findMany: vi.fn().mockResolvedValue([{
                    id: 'run-1', tenantId: 'tenant-1', status: 'completed', trigger: 'manual',
                    accountsScanned: 2, scopesPolled: 3, eventsSeen: 100, eventsCaptured: 90,
                    policySnapshots: 5, gapsDetected: 0, apiCallCount: 20, errors: 'oops',
                    startedAt: new Date('2026-02-01T00:00:00Z'), finishedAt: null,
                }]),
            },
        });
        vi.mocked(getTenantClient).mockReturnValue(db as any);

        const result = await repo.listRuns('tenant-1');
        expect(result.total).toBe(1);
        expect(result.runs[0].errors).toEqual([]);
        expect(result.runs[0].finishedAt).toBeNull();
    });
});

describe('getWatermarkGaps', () => {
    it('maps gap rows, tolerating null timestamps', async () => {
        const db = makeDb({
            scalingAuditWatermark: {
                findMany: vi.fn().mockResolvedValue([{
                    accountId: 'a1', region: 'us-east-1', scope: 'ecs', source: 'cloudtrail',
                    gapFromAt: null, gapToAt: new Date('2026-02-01T00:00:00Z'), gapReason: 'lookback exceeded', lastPolledAt: null,
                }]),
            },
        });
        vi.mocked(getTenantClient).mockReturnValue(db as any);

        const result = await repo.getWatermarkGaps('tenant-1');
        expect(result[0]).toEqual(expect.objectContaining({ gapFromAt: null, gapToAt: '2026-02-01T00:00:00.000Z', gapReason: 'lookback exceeded' }));
    });
});

describe('listPolicySnapshots', () => {
    it('scopes by tenant/account/region/resource and defaults non-array fields', async () => {
        const db = makeDb({
            scalingPolicySnapshot: {
                findMany: vi.fn().mockResolvedValue([{
                    id: 'ps-1', accountId: 'a1', region: 'us-east-1', scope: 'ecs', resourceId: 'res-1',
                    configHash: 'hash1', policies: 'not-array', scheduledActions: null,
                    minCapacity: 1, maxCapacity: 10, firstSeenAt: new Date('2026-01-01T00:00:00Z'), lastSeenAt: new Date('2026-02-01T00:00:00Z'),
                }]),
            },
        });
        vi.mocked(getTenantClient).mockReturnValue(db as any);

        const result = await repo.listPolicySnapshots('tenant-1', 'a1', 'us-east-1', 'res-1');
        expect(db.scalingPolicySnapshot.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { tenantId: 'tenant-1', accountId: 'a1', region: 'us-east-1', resourceId: 'res-1' },
        }));
        expect(result[0].policies).toEqual([]);
        expect(result[0].scheduledActions).toEqual([]);
    });
});

describe('getLatestSeal', () => {
    it('returns the most recent seal', async () => {
        const db = makeDb({ scalingAuditDailySeal: { findFirst: vi.fn().mockResolvedValue({ day: new Date('2026-02-01T00:00:00Z'), seal: 'abc', rowCount: 100 }) } });
        vi.mocked(getTenantClient).mockReturnValue(db as any);

        const result = await repo.getLatestSeal('tenant-1');
        expect(result).toEqual({ day: '2026-02-01', seal: 'abc', rowCount: 100 });
    });

    it('returns null when no seal exists yet', async () => {
        const db = makeDb({ scalingAuditDailySeal: { findFirst: vi.fn().mockResolvedValue(null) } });
        vi.mocked(getTenantClient).mockReturnValue(db as any);
        expect(await repo.getLatestSeal('tenant-1')).toBeNull();
    });
});
