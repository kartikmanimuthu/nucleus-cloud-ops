import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/pg-config', () => ({ getTenantClient: vi.fn() }));

import { getTenantClient } from '@/lib/db/pg-config';
import { CapacityPlanningPostgresRepository } from './postgres';

const repo = new CapacityPlanningPostgresRepository();

function makeGroupRow(overrides: Record<string, unknown> = {}) {
    return {
        resourceType: 'ecs', resourceId: 'res-1', accountId: 'acc-1', region: 'us-east-1',
        asgName: null, clusterName: 'cluster-1', serviceName: 'svc-1',
        _avg: { cpuAvg: 40, memAvg: 50 },
        _max: { cpuMax: 80, memMax: 90, installedVcpu: 4, installedMemGiB: 8, bucketStartUtc: new Date('2026-02-10T00:00:00Z') },
        _min: { bucketStartUtc: new Date('2026-02-01T00:00:00Z') },
        _count: { _all: 24 },
        ...overrides,
    };
}

function makeDb(overrides: Record<string, any> = {}) {
    return {
        capacityUtilizationSample: { groupBy: vi.fn(), findMany: vi.fn() },
        capacityPlanningRun: { count: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
        $queryRaw: vi.fn(),
        ...overrides,
    };
}

beforeEach(() => vi.clearAllMocks());

describe('getUtilizationSummary', () => {
    it('scopes the query by tenant and joins breach counts by resource key', async () => {
        const db = makeDb({
            capacityUtilizationSample: {
                groupBy: vi.fn()
                    .mockResolvedValueOnce([makeGroupRow()])
                    .mockResolvedValueOnce([{ resourceType: 'ecs', resourceId: 'res-1', accountId: 'acc-1', region: 'us-east-1', asgName: null, clusterName: 'cluster-1', serviceName: 'svc-1', _count: { _all: 3 } }]),
            },
        });
        vi.mocked(getTenantClient).mockReturnValue(db as any);

        const result = await repo.getUtilizationSummary({ tenantId: 'tenant-1' } as any, 70);

        expect(getTenantClient).toHaveBeenCalledWith('tenant-1');
        expect(result.total).toBe(1);
        expect(result.resources[0]).toEqual(expect.objectContaining({
            resourceId: 'res-1', displayName: 'svc-1', breachCount: 3, installedVcpu: 4,
        }));
    });

    it('falls back to resourceId as displayName when no ASG/service name is set', async () => {
        const db = makeDb({
            capacityUtilizationSample: {
                groupBy: vi.fn()
                    .mockResolvedValueOnce([makeGroupRow({ asgName: null, serviceName: null, resourceId: 'i-abc' })])
                    .mockResolvedValueOnce([]),
            },
        });
        vi.mocked(getTenantClient).mockReturnValue(db as any);

        const result = await repo.getUtilizationSummary({ tenantId: 'tenant-1' } as any);
        expect(result.resources[0].displayName).toBe('i-abc');
        expect(result.resources[0].breachCount).toBe(0);
    });

    it('scopes bucketStartUtc by dateFrom/dateTo and OR-matches searchTerm across resource/asg/service/cluster names', async () => {
        const groupBy = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]);
        const db = makeDb({ capacityUtilizationSample: { groupBy } });
        vi.mocked(getTenantClient).mockReturnValue(db as any);

        await repo.getUtilizationSummary({
            tenantId: 'tenant-1', dateFrom: '2026-02-01', dateTo: '2026-02-10', searchTerm: '  i-abc  ',
        } as any);

        const where = groupBy.mock.calls[0][0].where;
        expect(where.bucketStartUtc).toEqual({ gte: new Date('2026-02-01'), lte: new Date('2026-02-10') });
        expect(where.OR).toEqual([
            { resourceId: { contains: 'i-abc', mode: 'insensitive' } },
            { asgName: { contains: 'i-abc', mode: 'insensitive' } },
            { serviceName: { contains: 'i-abc', mode: 'insensitive' } },
            { clusterName: { contains: 'i-abc', mode: 'insensitive' } },
        ]);
    });

    it('paginates the sorted (most-recent-first) result set', async () => {
        const rows = [
            makeGroupRow({ resourceId: 'r1', _max: { ...makeGroupRow()._max, bucketStartUtc: new Date('2026-02-01T00:00:00Z') } }),
            makeGroupRow({ resourceId: 'r2', _max: { ...makeGroupRow()._max, bucketStartUtc: new Date('2026-02-10T00:00:00Z') } }),
        ];
        const db = makeDb({ capacityUtilizationSample: { groupBy: vi.fn().mockResolvedValueOnce(rows).mockResolvedValueOnce([]) } });
        vi.mocked(getTenantClient).mockReturnValue(db as any);

        const result = await repo.getUtilizationSummary({ tenantId: 'tenant-1', page: 1, limit: 1 } as any);
        expect(result.resources).toHaveLength(1);
        expect(result.resources[0].resourceId).toBe('r2'); // most recent first
        expect(result.total).toBe(2);
    });
});

describe('listBreachInstances', () => {
    it('emits a separate breach row per exceeded metric (cpu and/or mem)', async () => {
        const db = makeDb({
            capacityUtilizationSample: {
                findMany: vi.fn().mockResolvedValue([
                    { resourceType: 'ecs', resourceId: 'r1', accountId: 'a1', region: 'us-east-1', asgName: null, serviceName: 'svc', cpuMax: 95, memMax: 40, bucketStartUtc: new Date('2026-02-01T00:00:00Z') },
                    { resourceType: 'asg', resourceId: 'r2', accountId: 'a1', region: 'us-east-1', asgName: 'asg-1', serviceName: null, cpuMax: 30, memMax: 88, bucketStartUtc: new Date('2026-02-02T00:00:00Z') },
                ]),
            },
        });
        vi.mocked(getTenantClient).mockReturnValue(db as any);

        const result = await repo.listBreachInstances({ tenantId: 'tenant-1' } as any, 70);
        expect(result.total).toBe(2);
        expect(result.breaches.find(b => b.resourceId === 'r1')?.metric).toBe('cpu');
        expect(result.breaches.find(b => b.resourceId === 'r2')?.metric).toBe('mem');
    });

    it('paginates breach instances, most recent first', async () => {
        const db = makeDb({
            capacityUtilizationSample: {
                findMany: vi.fn().mockResolvedValue([
                    { resourceType: 'ecs', resourceId: 'r1', accountId: 'a1', region: 'us-east-1', asgName: null, serviceName: 's', cpuMax: 95, memMax: null, bucketStartUtc: new Date('2026-02-01T00:00:00Z') },
                    { resourceType: 'ecs', resourceId: 'r2', accountId: 'a1', region: 'us-east-1', asgName: null, serviceName: 's', cpuMax: 96, memMax: null, bucketStartUtc: new Date('2026-02-05T00:00:00Z') },
                ]),
            },
        });
        vi.mocked(getTenantClient).mockReturnValue(db as any);

        const result = await repo.listBreachInstances({ tenantId: 'tenant-1', page: 1, limit: 1 } as any);
        expect(result.breaches).toHaveLength(1);
        expect(result.breaches[0].resourceId).toBe('r2');
        expect(result.total).toBe(2);
    });
});

describe('getResourceDetail', () => {
    it('scopes the raw query by tenantId and returns computed signal summaries', async () => {
        const db = makeDb({
            $queryRaw: vi.fn().mockResolvedValue([{
                resourceType: 'ecs', resourceId: 'res-1', accountId: 'acc-1', region: 'us-east-1',
                clusterName: 'c1', serviceName: 's1', asgName: null,
                installedVcpu: 4, installedMemGiB: 8,
                firstSampleAt: new Date('2026-02-01T00:00:00Z'), lastSampleAt: new Date('2026-02-10T00:00:00Z'),
                sampleCount: 240n, breachCount: 5n,
                cpuAvg: 40, cpuP95: 75, cpuP99: 85, cpuMax: 90, cpuCount: 240n,
                memAvg: 50, memP95: 80, memP99: 90, memMax: 95, memCount: 240n,
            }]),
        });
        vi.mocked(getTenantClient).mockReturnValue(db as any);

        const result = await repo.getResourceDetail({ tenantId: 'tenant-1' } as any, 'res-1');

        expect(db.$queryRaw).toHaveBeenCalled();
        const sqlCall = db.$queryRaw.mock.calls[0];
        // Prisma.sql tagged-template fragments carry the interpolated values array.
        expect(JSON.stringify(sqlCall)).toContain('tenant-1');
        expect(result).toEqual(expect.objectContaining({
            resourceId: 'res-1', displayName: 's1', sampleCount: 240, breachCount: 5,
            metrics: { cpu: { avg: 40, p95: 75, p99: 85, max: 90, count: 240 }, memory: { avg: 50, p95: 80, p99: 90, max: 95, count: 240 } },
        }));
    });

    it('normalizes a single resourceType filter into a one-element IN list', async () => {
        const db = makeDb({ $queryRaw: vi.fn().mockResolvedValue([]) });
        vi.mocked(getTenantClient).mockReturnValue(db as any);

        await repo.getResourceDetail({ tenantId: 'tenant-1', resourceType: 'ecs' } as any, 'res-1');

        expect(JSON.stringify(db.$queryRaw.mock.calls[0])).toContain('ecs');
    });

    it('passes an array resourceType filter through to the IN list as-is', async () => {
        const db = makeDb({ $queryRaw: vi.fn().mockResolvedValue([]) });
        vi.mocked(getTenantClient).mockReturnValue(db as any);

        await repo.getResourceDetail({ tenantId: 'tenant-1', resourceType: ['ecs', 'asg'] } as any, 'res-1');

        const sql = JSON.stringify(db.$queryRaw.mock.calls[0]);
        expect(sql).toContain('ecs');
        expect(sql).toContain('asg');
    });

    it('returns null when no samples exist for the resource', async () => {
        const db = makeDb({ $queryRaw: vi.fn().mockResolvedValue([]) });
        vi.mocked(getTenantClient).mockReturnValue(db as any);

        expect(await repo.getResourceDetail({ tenantId: 'tenant-1' } as any, 'res-missing')).toBeNull();
    });

    it('reports a null metric signal when its count is zero', async () => {
        const db = makeDb({
            $queryRaw: vi.fn().mockResolvedValue([{
                resourceType: 'ecs', resourceId: 'res-1', accountId: 'acc-1', region: 'us-east-1',
                clusterName: null, serviceName: null, asgName: null,
                installedVcpu: null, installedMemGiB: null,
                firstSampleAt: new Date(), lastSampleAt: new Date(),
                sampleCount: 10n, breachCount: 0n,
                cpuAvg: 40, cpuP95: 75, cpuP99: 85, cpuMax: 90, cpuCount: 10n,
                memAvg: null, memP95: null, memP99: null, memMax: null, memCount: 0n,
            }]),
        });
        vi.mocked(getTenantClient).mockReturnValue(db as any);

        const result = await repo.getResourceDetail({ tenantId: 'tenant-1' } as any, 'res-1');
        expect(result!.metrics.memory).toBeNull();
        expect(result!.metrics.cpu).not.toBeNull();
    });
});

describe('listRuns', () => {
    it('paginates runs scoped by tenant and transforms row shape', async () => {
        const db = makeDb({
            capacityPlanningRun: {
                count: vi.fn().mockResolvedValue(1),
                findMany: vi.fn().mockResolvedValue([{
                    id: 'run-1', tenantId: 'tenant-1', status: 'completed', trigger: 'manual',
                    accountsScanned: 2, resourcesScanned: 10, samplesWritten: 100, errors: [],
                    startedAt: new Date('2026-02-01T00:00:00Z'), finishedAt: new Date('2026-02-01T00:05:00Z'),
                }]),
            },
        });
        vi.mocked(getTenantClient).mockReturnValue(db as any);

        const result = await repo.listRuns('tenant-1', 1, 20);
        expect(db.capacityPlanningRun.count).toHaveBeenCalledWith({ where: { tenantId: 'tenant-1' } });
        expect(result.runs[0].finishedAt).toBe('2026-02-01T00:05:00.000Z');
        expect(result.total).toBe(1);
    });

    it('defaults errors to an empty array when the stored value is not an array', async () => {
        const db = makeDb({
            capacityPlanningRun: {
                count: vi.fn().mockResolvedValue(1),
                findMany: vi.fn().mockResolvedValue([{
                    id: 'run-1', tenantId: 'tenant-1', status: 'failed', trigger: 'scheduled',
                    accountsScanned: 0, resourcesScanned: 0, samplesWritten: 0, errors: 'not-an-array',
                    startedAt: new Date(), finishedAt: null,
                }]),
            },
        });
        vi.mocked(getTenantClient).mockReturnValue(db as any);

        const result = await repo.listRuns('tenant-1');
        expect(result.runs[0].errors).toEqual([]);
        expect(result.runs[0].finishedAt).toBeNull();
    });
});

describe('getActiveRun', () => {
    it('returns the most recent queued/running run for the tenant', async () => {
        const db = makeDb({
            capacityPlanningRun: {
                findFirst: vi.fn().mockResolvedValue({
                    id: 'run-1', tenantId: 'tenant-1', status: 'running', trigger: 'manual',
                    accountsScanned: 1, resourcesScanned: 5, samplesWritten: 50, errors: [],
                    startedAt: new Date(), finishedAt: null,
                }),
            },
        });
        vi.mocked(getTenantClient).mockReturnValue(db as any);

        const result = await repo.getActiveRun('tenant-1');
        expect(db.capacityPlanningRun.findFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: { tenantId: 'tenant-1', status: { in: ['queued', 'running'] } },
        }));
        expect(result?.id).toBe('run-1');
    });

    it('returns null when no active run exists', async () => {
        const db = makeDb({ capacityPlanningRun: { findFirst: vi.fn().mockResolvedValue(null) } });
        vi.mocked(getTenantClient).mockReturnValue(db as any);
        expect(await repo.getActiveRun('tenant-1')).toBeNull();
    });
});
