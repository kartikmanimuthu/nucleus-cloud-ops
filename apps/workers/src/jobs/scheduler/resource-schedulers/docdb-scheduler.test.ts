import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('@aws-sdk/client-rds', () => ({
    RDSClient: vi.fn().mockImplementation(function (this: any) { this.send = mockSend; }),
    DescribeDBClustersCommand: vi.fn().mockImplementation(function (this: any, input: unknown) { this.input = input; }),
    StartDBClusterCommand: vi.fn().mockImplementation(function (this: any, input: unknown) { this.input = input; }),
    StopDBClusterCommand: vi.fn().mockImplementation(function (this: any, input: unknown) { this.input = input; }),
}));
vi.mock('../services/dynamodb-service.js', () => ({ createAuditLog: vi.fn().mockResolvedValue(undefined) }));

import { StartDBClusterCommand, StopDBClusterCommand } from '@aws-sdk/client-rds';
import { createAuditLog } from '../services/dynamodb-service.js';
import { processDocDBResource } from './docdb-scheduler.js';
import type { Schedule, ScheduleResource, AssumedCredentials, SchedulerMetadata } from '../types/index.js';

const resource: ScheduleResource = { id: 'docdb-1', type: 'docdb', name: 'my-docdb', arn: 'arn:aws:rds:us-east-1:123:cluster:docdb-1' };
const schedule: Schedule = { scheduleId: 's1', name: 'Nightly', type: 'schedule', starttime: '18:00', endtime: '08:00', timezone: 'UTC', active: true, days: ['Mon'], tenantId: 'tenant-1' };
const credentials: AssumedCredentials = { credentials: { accessKeyId: 'ak', secretAccessKey: 'sk', sessionToken: 'st' }, region: 'us-east-1' };
const metadata: SchedulerMetadata = { account: { name: 'Prod', accountId: 'acc-1' }, region: 'us-east-1', executionId: 'exec-1' };

function describeResult(status: string, members: Array<{ DBInstanceIdentifier: string; IsClusterWriter: boolean }> = []) {
    return { DBClusters: [{ Status: status, Engine: 'docdb', Endpoint: 'x', DBClusterMembers: members }] };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
});

describe('processDocDBResource', () => {
    it('starts a stopped cluster and logs a success audit event', async () => {
        mockSend.mockResolvedValueOnce(describeResult('stopped')).mockResolvedValueOnce({});

        const result = await processDocDBResource(resource, schedule, 'start', credentials, metadata);

        expect(mockSend).toHaveBeenNthCalledWith(2, expect.any(StartDBClusterCommand));
        expect(result).toEqual(expect.objectContaining({ action: 'start', status: 'success' }));
        expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'scheduler.docdb.start', tenantId: 'tenant-1' }));
    });

    it('pre-emptively starts an "available" cluster that has members (may have stopped instances)', async () => {
        mockSend.mockResolvedValueOnce(describeResult('available', [{ DBInstanceIdentifier: 'i-1', IsClusterWriter: true }])).mockResolvedValueOnce({});

        const result = await processDocDBResource(resource, schedule, 'start', credentials, metadata);
        expect(mockSend).toHaveBeenCalledTimes(2);
        expect(result.action).toBe('start');
    });

    it('skips start when the cluster is available with no members', async () => {
        mockSend.mockResolvedValueOnce(describeResult('available', []));
        const result = await processDocDBResource(resource, schedule, 'start', credentials, metadata);
        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(result.action).toBe('skip');
    });

    it('stops an available cluster and logs a success audit event', async () => {
        mockSend.mockResolvedValueOnce(describeResult('available')).mockResolvedValueOnce({});

        const result = await processDocDBResource(resource, schedule, 'stop', credentials, metadata);
        expect(mockSend).toHaveBeenNthCalledWith(2, expect.any(StopDBClusterCommand));
        expect(result.action).toBe('stop');
        expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'scheduler.docdb.stop' }));
    });

    it('does not stop a cluster that is not available', async () => {
        mockSend.mockResolvedValueOnce(describeResult('stopped'));
        const result = await processDocDBResource(resource, schedule, 'stop', credentials, metadata);
        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(result.action).toBe('skip');
    });

    it('dry-run mode reports the intended start without mutating', async () => {
        mockSend.mockResolvedValueOnce(describeResult('stopped'));
        const result = await processDocDBResource(resource, schedule, 'start', credentials, { ...metadata, dryRun: true });
        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(result.action).toBe('start');
        expect(createAuditLog).not.toHaveBeenCalled();
    });

    it('dry-run mode reports the intended stop without mutating', async () => {
        mockSend.mockResolvedValueOnce(describeResult('available'));
        const result = await processDocDBResource(resource, schedule, 'stop', credentials, { ...metadata, dryRun: true });
        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(result.action).toBe('stop');
        expect(createAuditLog).not.toHaveBeenCalled();
    });

    it('tolerates InvalidDBClusterStateFault when starting an already-available cluster, returning skip', async () => {
        mockSend.mockResolvedValueOnce(describeResult('starting')); // needsStart=true (not available/starting check: 'starting' IS one of the excluded — use a status that forces needsStart)
        // Use a status that triggers needsStart but the mutation reports already-available.
        mockSend.mockReset();
        mockSend.mockResolvedValueOnce(describeResult('stopping'));
        const err = Object.assign(new Error('already available'), { name: 'InvalidDBClusterStateFault' });
        mockSend.mockRejectedValueOnce(err);

        const result = await processDocDBResource(resource, schedule, 'start', credentials, metadata);
        expect(result).toEqual(expect.objectContaining({ action: 'skip', status: 'success' }));
    });

    it('re-throws (and reports failed) a different InvalidDBClusterStateFault message', async () => {
        mockSend.mockResolvedValueOnce(describeResult('stopping'));
        const err = Object.assign(new Error('cluster is deleting'), { name: 'InvalidDBClusterStateFault' });
        mockSend.mockRejectedValueOnce(err);

        const result = await processDocDBResource(resource, schedule, 'start', credentials, metadata);
        expect(result.status).toBe('failed');
        expect(result.error).toBe('cluster is deleting');
    });

    it('returns a failed result and logs a high-severity error when the cluster is not found', async () => {
        mockSend.mockResolvedValueOnce({ DBClusters: [] });
        const result = await processDocDBResource(resource, schedule, 'start', credentials, metadata);
        expect(result).toEqual(expect.objectContaining({ status: 'failed', error: expect.stringContaining('not found') }));
        expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'scheduler.docdb.error', severity: 'high' }));
    });

    it('returns a failed result when the stop mutation throws a non-fault error', async () => {
        mockSend.mockResolvedValueOnce(describeResult('available')).mockRejectedValueOnce(new Error('AccessDenied'));
        const result = await processDocDBResource(resource, schedule, 'stop', credentials, metadata);
        expect(result.status).toBe('failed');
        expect(result.error).toBe('AccessDenied');
    });

    it('surfaces a non-Error throw as a stringified message', async () => {
        mockSend.mockRejectedValueOnce('raw failure');
        const result = await processDocDBResource(resource, schedule, 'start', credentials, metadata);
        expect(result.error).toBe('raw failure');
    });
});
