import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../env.js', () => ({ env: { USE_PG_SCHEDULES: 'true' } }));
vi.mock('./dynamodb-service.js', () => ({
    createAuditLog: vi.fn().mockResolvedValue(undefined),
    createExecutionAuditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./pg-service.js', () => ({
    getActiveTenants: vi.fn(),
    getSchedules: vi.fn(),
    getScheduleById: vi.fn(),
    getAccounts: vi.fn(),
    logExecution: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./execution-history-service.js', () => ({
    createExecutionRecord: vi.fn().mockResolvedValue({ executionId: 'exec-record-1' }),
    updateExecutionRecord: vi.fn().mockResolvedValue(undefined),
    getLastECSServiceState: vi.fn().mockResolvedValue(null),
    getLastEC2InstanceState: vi.fn().mockResolvedValue(null),
    getLastRDSInstanceState: vi.fn().mockResolvedValue(null),
    getLastASGState: vi.fn().mockResolvedValue(null),
}));
vi.mock('./sts-service.js', () => ({ assumeRole: vi.fn() }));
vi.mock('../resource-schedulers/index.js', () => ({
    processEC2Resource: vi.fn(),
    processRDSResource: vi.fn(),
    processECSResource: vi.fn(),
    processASGResource: vi.fn(),
    processDocDBResource: vi.fn(),
}));
vi.mock('../utils/time-utils.js', () => ({ isCurrentTimeInRange: vi.fn() }));

import {
    computeExecutionStatus,
    resolveRunStatus,
    pushFailedResource,
    mapWithConcurrency,
    runFullScan,
    runPartialScan,
} from './scheduler-service.js';
import { createAuditLog, createExecutionAuditLog } from './dynamodb-service.js';
import { getActiveTenants, getSchedules, getScheduleById, getAccounts } from './pg-service.js';
import { createExecutionRecord, updateExecutionRecord } from './execution-history-service.js';
import { assumeRole } from './sts-service.js';
import { processEC2Resource } from '../resource-schedulers/index.js';
import { isCurrentTimeInRange } from '../utils/time-utils.js';
import type { ScheduleExecutionMetadata, ScheduleResource, Schedule, Account, EC2ResourceExecution } from '../types/index.js';

function emptyMeta(): ScheduleExecutionMetadata {
    return { ec2: [], ecs: [], rds: [], asg: [], docdb: [] };
}

describe('computeExecutionStatus', () => {
    it('returns success when there are no failures', () => {
        expect(computeExecutionStatus(0, 0, 0)).toBe('success');
        expect(computeExecutionStatus(3, 2, 0)).toBe('success');
    });

    it('returns failed when work was attempted but nothing succeeded', () => {
        expect(computeExecutionStatus(0, 0, 5)).toBe('failed');
    });

    it('returns partial when some succeeded and some failed', () => {
        expect(computeExecutionStatus(1, 0, 2)).toBe('partial');
        expect(computeExecutionStatus(0, 4, 1)).toBe('partial');
    });
});

describe('resolveRunStatus', () => {
    it('returns no_action for a run that changed nothing (so no-op runs are still recorded)', () => {
        expect(resolveRunStatus(0, 0, 0)).toBe('no_action');
    });

    it('matches computeExecutionStatus whenever any work happened', () => {
        expect(resolveRunStatus(3, 0, 0)).toBe('success');
        expect(resolveRunStatus(0, 2, 0)).toBe('success');
        expect(resolveRunStatus(0, 0, 5)).toBe('failed');
        expect(resolveRunStatus(1, 0, 2)).toBe('partial');
    });
});

describe('pushFailedResource', () => {
    const cases: Array<{ type: ScheduleResource['type']; bucket: keyof ScheduleExecutionMetadata }> = [
        { type: 'ec2', bucket: 'ec2' },
        { type: 'rds', bucket: 'rds' },
        { type: 'ecs', bucket: 'ecs' },
        { type: 'asg', bucket: 'asg' },
        { type: 'docdb', bucket: 'docdb' },
    ];

    for (const { type, bucket } of cases) {
        it(`records a ${type} failure in the ${bucket} bucket with the error message`, () => {
            const meta = emptyMeta();
            const resource: ScheduleResource = {
                id: `res-${type}`,
                type,
                arn: `arn:aws:${type}:ap-south-1:111122223333:thing/res-${type}`,
            };
            pushFailedResource(meta, resource, 'stop', 'boom');
            expect(meta[bucket]).toHaveLength(1);
            const entry = meta[bucket][0] as { status: string; action: string; error?: string; resourceId: string };
            expect(entry.status).toBe('failed');
            expect(entry.action).toBe('stop');
            expect(entry.error).toBe('boom');
            expect(entry.resourceId).toBe(`res-${type}`);
        });
    }

    it('defaults ECS clusterArn to "unknown" when not provided', () => {
        const meta = emptyMeta();
        pushFailedResource(meta, { id: 's', type: 'ecs', arn: 'arn:aws:ecs:...' }, 'start', 'err');
        expect(meta.ecs[0].clusterArn).toBe('unknown');
    });
});

describe('mapWithConcurrency', () => {
    it('processes every item exactly once', async () => {
        const items = Array.from({ length: 50 }, (_, i) => i);
        const seen: number[] = [];
        await mapWithConcurrency(items, 8, async (n) => { seen.push(n); });
        expect(seen.sort((a, b) => a - b)).toEqual(items);
    });

    it('never exceeds the concurrency limit in flight', async () => {
        const items = Array.from({ length: 30 }, (_, i) => i);
        let inFlight = 0;
        let peak = 0;
        await mapWithConcurrency(items, 5, async () => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await Promise.resolve(); // yield so tasks overlap
            inFlight--;
        });
        expect(peak).toBeLessThanOrEqual(5);
        expect(peak).toBeGreaterThan(1); // actually ran concurrently
    });

    it('handles an empty list without spawning workers', async () => {
        let calls = 0;
        await mapWithConcurrency([], 8, async () => { calls++; });
        expect(calls).toBe(0);
    });
});

// --- Orchestration tests (runFullScan / runPartialScan / processSchedule via them) ---

const tenant = { id: 'tenant-1', name: 'Tenant One' };
const account: Account = {
    accountId: '111122223333',
    name: 'Prod',
    accountName: 'Prod',
    roleArn: 'arn:aws:iam::111122223333:role/scan',
    externalId: 'ext-1',
    regions: ['us-east-1'],
    active: true,
};
const ec2Resource: ScheduleResource = { id: 'i-1', type: 'ec2', arn: 'arn:aws:ec2:us-east-1:111122223333:instance/i-1' };
const schedule: Schedule = {
    scheduleId: 's1', name: 'Nightly', type: 'schedule', starttime: '18:00', endtime: '08:00',
    timezone: 'UTC', active: true, days: ['Mon'], tenantId: tenant.id, accountId: account.accountId,
    resources: [ec2Resource],
};
const successResult: EC2ResourceExecution = {
    arn: ec2Resource.arn, resourceId: ec2Resource.id, action: 'start', status: 'success',
    last_state: { instanceState: 'running' },
};

beforeEach(() => {
    vi.clearAllMocks();
    (assumeRole as any).mockReset().mockResolvedValue({ credentials: { accessKeyId: 'ak', secretAccessKey: 'sk', sessionToken: 'st' }, region: 'us-east-1' });
    (isCurrentTimeInRange as any).mockReset().mockReturnValue(true);
    (processEC2Resource as any).mockReset().mockResolvedValue(successResult);
    (getActiveTenants as any).mockReset();
    (getSchedules as any).mockReset();
    (getAccounts as any).mockReset();
    (getScheduleById as any).mockReset();
    (createExecutionRecord as any).mockReset().mockResolvedValue({ executionId: 'exec-record-1' });
});

describe('runFullScan', () => {
    it('returns an empty success result when there are no active tenants', async () => {
        (getActiveTenants as any).mockResolvedValue([]);
        const result = await runFullScan();
        expect(result).toEqual(expect.objectContaining({ success: true, schedulesProcessed: 0, resourcesStarted: 0 }));
        expect(createAuditLog).not.toHaveBeenCalled();
    });

    it('checks but does not process a tenant with no schedules', async () => {
        (getActiveTenants as any).mockResolvedValue([tenant]);
        (getSchedules as any).mockResolvedValue([]);
        (getAccounts as any).mockResolvedValue([account]);

        const result = await runFullScan();

        expect(result.checkedTenantIds).toEqual([tenant.id]);
        expect(result.processedTenantIds).toEqual([]);
        expect(createAuditLog).not.toHaveBeenCalled();
    });

    it('starts a resource successfully and records the execution', async () => {
        (getActiveTenants as any).mockResolvedValue([tenant]);
        (getSchedules as any).mockResolvedValue([schedule]);
        (getAccounts as any).mockResolvedValue([account]);

        const result = await runFullScan();

        expect(result.resourcesStarted).toBe(1);
        expect(result.resourcesFailed).toBe(0);
        expect(processEC2Resource).toHaveBeenCalledWith(ec2Resource, schedule, 'start', expect.any(Object), expect.any(Object), undefined);
        expect(createExecutionRecord).toHaveBeenCalled();
        expect(updateExecutionRecord).toHaveBeenCalled();
        expect(createExecutionAuditLog).toHaveBeenCalled();
        expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'schedule.execution.completed', status: 'success', tenantId: tenant.id }));
    });

    it('records a no_action run without writing an execution record when nothing changed', async () => {
        const noopSchedule: Schedule = { ...schedule, resources: [] };
        (getActiveTenants as any).mockResolvedValue([tenant]);
        (getSchedules as any).mockResolvedValue([noopSchedule]);
        (getAccounts as any).mockResolvedValue([account]);

        await runFullScan();

        expect(createExecutionRecord).not.toHaveBeenCalled();
        expect(createExecutionAuditLog).not.toHaveBeenCalled();
        expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'schedule.execution.completed', status: 'success' }));
    });

    it('counts a failed resource execution and reports high severity when nothing succeeded', async () => {
        (getActiveTenants as any).mockResolvedValue([tenant]);
        (getSchedules as any).mockResolvedValue([schedule]);
        (getAccounts as any).mockResolvedValue([account]);
        (processEC2Resource as any).mockResolvedValue({ ...successResult, status: 'failed', error: 'boom' });

        const result = await runFullScan();

        expect(result.resourcesFailed).toBe(1);
        expect(result.errors?.[0]).toContain('boom');
        expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'schedule.execution.completed', status: 'error', severity: 'high' }));
    });

    it('fails every resource for an account that is not found among active accounts', async () => {
        const unrelatedAccount: Account = { ...account, accountId: '999988887777' };
        (getActiveTenants as any).mockResolvedValue([tenant]);
        (getSchedules as any).mockResolvedValue([schedule]);
        (getAccounts as any).mockResolvedValue([unrelatedAccount]); // present, but not the account the resource's ARN references

        const result = await runFullScan();

        expect(result.resourcesFailed).toBe(1);
        expect(processEC2Resource).not.toHaveBeenCalled();
        expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'scheduler.account.error', severity: 'high' }));
    });

    it('fails every resource in a region when assumeRole throws', async () => {
        (getActiveTenants as any).mockResolvedValue([tenant]);
        (getSchedules as any).mockResolvedValue([schedule]);
        (getAccounts as any).mockResolvedValue([account]);
        (assumeRole as any).mockRejectedValue(new Error('AccessDenied'));

        const result = await runFullScan();

        expect(result.resourcesFailed).toBe(1);
        expect(processEC2Resource).not.toHaveBeenCalled();
        expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'scheduler.assume_role.error', severity: 'high' }));
    });

    it('scopes a full scan to a single tenant via tenantIdFilter', async () => {
        const otherTenant = { id: 'tenant-2', name: 'Other' };
        (getActiveTenants as any).mockResolvedValue([tenant, otherTenant]);
        (getSchedules as any).mockResolvedValue([]);
        (getAccounts as any).mockResolvedValue([]);

        const result = await runFullScan('system', tenant.id);

        expect(result.checkedTenantIds).toEqual([tenant.id]);
        expect(getSchedules).toHaveBeenCalledTimes(1);
        expect(getSchedules).toHaveBeenCalledWith(tenant.id);
    });

    it('stops the schedule when action resolves to stop (out of time window)', async () => {
        (getActiveTenants as any).mockResolvedValue([tenant]);
        (getSchedules as any).mockResolvedValue([schedule]);
        (getAccounts as any).mockResolvedValue([account]);
        (isCurrentTimeInRange as any).mockReturnValue(false);
        (processEC2Resource as any).mockResolvedValue({ ...successResult, action: 'stop' });

        const result = await runFullScan();

        expect(result.resourcesStopped).toBe(1);
        expect(processEC2Resource).toHaveBeenCalledWith(ec2Resource, schedule, 'stop', expect.any(Object), expect.any(Object), undefined);
    });
});

describe('runPartialScan', () => {
    const event = { scheduleId: schedule.scheduleId, tenantId: tenant.id, userEmail: 'user@example.com' };

    it('throws when neither scheduleId nor scheduleName is provided', async () => {
        await expect(runPartialScan({ tenantId: tenant.id })).rejects.toThrow('scheduleId or scheduleName is required');
    });

    it('throws when tenantId is missing', async () => {
        await expect(runPartialScan({ scheduleId: 's1' })).rejects.toThrow('tenantId is required');
    });

    it('audits and throws when the schedule is not found', async () => {
        (getScheduleById as any).mockResolvedValue(null);

        await expect(runPartialScan(event)).rejects.toThrow('Schedule not found: s1');
        expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'schedule.execution.failed', severity: 'high' }));
    });

    it('processes the schedule and reports a completed audit log on success', async () => {
        (getScheduleById as any).mockResolvedValue(schedule);
        (getAccounts as any).mockResolvedValue([account]);

        const result = await runPartialScan(event);

        expect(result.resourcesStarted).toBe(1);
        expect(result.success).toBe(true);
        expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'schedule.execution.completed', tenantId: tenant.id }));
    });

    it('audits a failure and rethrows when processing the schedule throws unexpectedly', async () => {
        (getScheduleById as any).mockResolvedValue(schedule);
        (getAccounts as any).mockResolvedValue([account]);
        (isCurrentTimeInRange as any).mockImplementation(() => { throw new Error('boom'); });

        await expect(runPartialScan(event)).rejects.toThrow('boom');
        expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'schedule.execution.failed', severity: 'high' }));
    });
});
