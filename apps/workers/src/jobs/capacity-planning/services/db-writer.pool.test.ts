// Raw-pg persistence for capacity-planning (SA-004) — not intercepted by any tenant
// extension, so every test here asserts an explicit tenantId predicate/param.
// Split from db-writer.test.ts (pure parseEcsServiceArn, mock-free) because this file
// needs the pg pool mocked — same split used by right-sizing/services/db-writer.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { connect, query, release } = vi.hoisted(() => ({
    connect: vi.fn(),
    query: vi.fn(),
    release: vi.fn(),
}));

vi.mock('../../discovery/services/db.js', () => ({ getPool: () => ({ connect }) }));

import {
    getEcsServicesToScan,
    getAsgsToScan,
    getLastBucket,
    upsertSamples,
    createRun,
    finishRun,
    hasActiveRun,
} from './db-writer.js';
import type { CapacitySample } from '../types.js';

beforeEach(() => {
    vi.clearAllMocks();
    connect.mockResolvedValue({ query, release });
    query.mockResolvedValue({ rows: [] });
});

describe('getEcsServicesToScan', () => {
    it('scopes the read by tenantId AND accountId and parses each service ARN', async () => {
        query.mockResolvedValueOnce({
            rows: [{ resourceId: 'arn:aws:ecs:ap-south-1:123:service/my-cluster/my-svc', taskDefinitionArn: 'arn:aws:ecs:ap-south-1:123:task-definition/td:1' }],
        });

        const result = await getEcsServicesToScan('tenant-1', 'account-1');

        expect(result).toEqual([{ resourceType: 'ecs', resourceId: 'arn:aws:ecs:ap-south-1:123:service/my-cluster/my-svc', clusterName: 'my-cluster', serviceName: 'my-svc', taskDefinitionArn: 'arn:aws:ecs:ap-south-1:123:task-definition/td:1' }]);
        const [sql, params] = query.mock.calls[0];
        expect(sql).toContain('"tenantId" = $1 AND "accountId" = $2');
        expect(params).toEqual(['tenant-1', 'account-1']);
        expect(release).toHaveBeenCalled();
    });

    it('skips a row whose resourceId does not match the expected ARN shape', async () => {
        query.mockResolvedValueOnce({ rows: [{ resourceId: 'not-an-arn', taskDefinitionArn: null }] });
        expect(await getEcsServicesToScan('tenant-1', 'account-1')).toEqual([]);
    });
});

describe('getAsgsToScan', () => {
    it('scopes the read by tenantId AND accountId and returns bare group names', async () => {
        query.mockResolvedValueOnce({ rows: [{ resourceId: 'my-asg' }] });
        const result = await getAsgsToScan('tenant-1', 'account-1');
        expect(result).toEqual([{ resourceType: 'asg', resourceId: 'my-asg', asgName: 'my-asg' }]);
        const [sql, params] = query.mock.calls[0];
        expect(sql).toContain('"tenantId" = $1 AND "accountId" = $2');
        expect(params).toEqual(['tenant-1', 'account-1']);
    });
});

describe('getLastBucket', () => {
    it('scopes the watermark read by tenantId, resourceType, and resourceId', async () => {
        const lastBucket = new Date('2026-08-20T00:00:00Z');
        query.mockResolvedValueOnce({ rows: [{ lastBucket }] });
        const result = await getLastBucket('tenant-1', 'ecs', 'svc-1');
        expect(result).toBe(lastBucket);
        const [sql, params] = query.mock.calls[0];
        expect(sql).toContain('"tenantId" = $1 AND "resourceType" = $2 AND "resourceId" = $3');
        expect(params).toEqual(['tenant-1', 'ecs', 'svc-1']);
    });

    it('returns null when the resource has never been sampled', async () => {
        query.mockResolvedValueOnce({ rows: [{ lastBucket: null }] });
        expect(await getLastBucket('tenant-1', 'ecs', 'svc-1')).toBeNull();
    });
});

function sample(overrides: Partial<CapacitySample> = {}): CapacitySample {
    return {
        tenantId: 'tenant-1', accountId: 'account-1', region: 'us-east-1', resourceType: 'ecs',
        resourceId: 'svc-1', clusterName: 'c1', serviceName: 'svc-1', bucketStartUtc: new Date('2026-08-24T00:00:00Z'),
        cpuAvg: 20, cpuMax: 40, memAvg: 30, memMax: 50, installedVcpu: 2, installedMemGiB: 4, ...overrides,
    };
}

describe('upsertSamples', () => {
    it('returns 0 and never connects for an empty sample list', async () => {
        expect(await upsertSamples([], 'run-1')).toBe(0);
        expect(connect).not.toHaveBeenCalled();
    });

    it('writes one row per sample, scoped by tenantId, and sums rowCount', async () => {
        query.mockResolvedValue({ rowCount: 1 });
        const written = await upsertSamples([sample({ resourceId: 'svc-1' }), sample({ resourceId: 'svc-2' })], 'run-1');

        expect(written).toBe(2);
        expect(query).toHaveBeenCalledTimes(2);
        for (const call of query.mock.calls) {
            const [sql, params] = call;
            expect(sql).toContain('ON CONFLICT ("tenantId", "resourceType", "resourceId", "bucketStartUtc")');
            expect(params[0]).toBe('tenant-1');
        }
        expect(release).toHaveBeenCalled();
    });

    it('re-throws and releases the client when an insert fails partway through', async () => {
        query.mockResolvedValueOnce({ rowCount: 1 }).mockRejectedValueOnce(new Error('constraint violation'));
        await expect(upsertSamples([sample(), sample({ resourceId: 'svc-2' })], 'run-1')).rejects.toThrow('constraint violation');
        expect(release).toHaveBeenCalled();
    });
});

describe('createRun', () => {
    it('inserts a running run scoped to the tenant and returns its id', async () => {
        query.mockResolvedValueOnce({ rows: [{ id: 'run-123' }] });
        const id = await createRun('tenant-1', 'schedule');
        expect(id).toBe('run-123');
        const [sql, params] = query.mock.calls[0];
        expect(sql).toContain('"tenantId"');
        expect(params).toEqual(['tenant-1', 'schedule']);
    });
});

describe('finishRun', () => {
    it('updates the run scoped by BOTH id and tenantId', async () => {
        await finishRun('run-123', 'tenant-1', { status: 'completed', accountsScanned: 2, resourcesScanned: 5, samplesWritten: 5, errors: [] });
        const [sql, params] = query.mock.calls[0];
        expect(sql).toContain('WHERE id = $1 AND "tenantId" = $2');
        expect(params[0]).toBe('run-123');
        expect(params[1]).toBe('tenant-1');
    });
});

describe('hasActiveRun', () => {
    it('scopes the check by tenantId and returns true when a queued/running row exists', async () => {
        query.mockResolvedValueOnce({ rows: [{}], rowCount: 1 });
        expect(await hasActiveRun('tenant-1')).toBe(true);
        const [sql, params] = query.mock.calls[0];
        expect(sql).toContain('"tenantId" = $1');
        expect(params[0]).toBe('tenant-1');
    });

    it('returns false when no active run exists', async () => {
        query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
        expect(await hasActiveRun('tenant-1')).toBe(false);
    });
});
