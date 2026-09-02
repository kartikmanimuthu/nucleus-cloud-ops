import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('@aws-sdk/client-rds', () => ({
    RDSClient: vi.fn().mockImplementation(function (this: any) { this.send = mockSend; }),
    DescribeDBInstancesCommand: vi.fn().mockImplementation(function (this: any, input: unknown) { this.input = input; }),
    StartDBInstanceCommand: vi.fn().mockImplementation(function (this: any, input: unknown) { this.input = input; }),
    StopDBInstanceCommand: vi.fn().mockImplementation(function (this: any, input: unknown) { this.input = input; }),
}));
vi.mock('../services/dynamodb-service.js', () => ({ createAuditLog: vi.fn().mockResolvedValue(undefined) }));

import { StartDBInstanceCommand, StopDBInstanceCommand } from '@aws-sdk/client-rds';
import { createAuditLog } from '../services/dynamodb-service.js';
import { processRDSResource, extractRDSIdentifier, extractRegionFromArn } from './rds-scheduler.js';
import type { Schedule, ScheduleResource, AssumedCredentials, SchedulerMetadata } from '../types/index.js';

const resource: ScheduleResource = { id: 'db-1', type: 'rds', name: 'prod-db', arn: 'arn:aws:rds:us-east-1:123:db:db-1' };
const schedule: Schedule = { scheduleId: 's1', name: 'Nightly', type: 'schedule', starttime: '18:00', endtime: '08:00', timezone: 'UTC', active: true, days: ['Mon'], tenantId: 'tenant-1' };
const credentials: AssumedCredentials = { credentials: { accessKeyId: 'ak', secretAccessKey: 'sk', sessionToken: 'st' }, region: 'us-east-1' };
const metadata: SchedulerMetadata = { account: { name: 'Prod', accountId: 'acc-1' }, region: 'us-east-1', executionId: 'exec-1' };

function describeResult(status: string, dbInstanceClass = 'db.t3.micro') {
    return { DBInstances: [{ DBInstanceStatus: status, DBInstanceClass: dbInstanceClass, Engine: 'postgres', Endpoint: undefined }] };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
});

describe('processRDSResource', () => {
    it('starts a stopped instance and logs a success audit event', async () => {
        mockSend.mockResolvedValueOnce(describeResult('stopped')).mockResolvedValueOnce({});

        const result = await processRDSResource(resource, schedule, 'start', credentials, metadata);

        expect(mockSend).toHaveBeenNthCalledWith(2, expect.any(StartDBInstanceCommand));
        expect(result).toEqual(expect.objectContaining({ action: 'start', status: 'success', last_state: { dbInstanceStatus: 'stopped', dbInstanceClass: 'db.t3.micro' } }));
        expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'scheduler.rds.start', tenantId: 'tenant-1' }));
    });

    it('stops an available instance and logs a success audit event', async () => {
        mockSend.mockResolvedValueOnce(describeResult('available')).mockResolvedValueOnce({});

        const result = await processRDSResource(resource, schedule, 'stop', credentials, metadata);

        expect(mockSend).toHaveBeenNthCalledWith(2, expect.any(StopDBInstanceCommand));
        expect(result.action).toBe('stop');
        expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'scheduler.rds.stop' }));
    });

    it('skips when already in the desired state (start while starting)', async () => {
        mockSend.mockResolvedValueOnce(describeResult('starting'));
        const result = await processRDSResource(resource, schedule, 'start', credentials, metadata);
        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(result.action).toBe('skip');
        expect(createAuditLog).not.toHaveBeenCalled();
    });

    it('does not stop an instance that is not available (e.g. already stopped)', async () => {
        mockSend.mockResolvedValueOnce(describeResult('stopped'));
        const result = await processRDSResource(resource, schedule, 'stop', credentials, metadata);
        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(result.action).toBe('skip');
    });

    it('dry-run mode reports the intended start without mutating or auditing', async () => {
        mockSend.mockResolvedValueOnce(describeResult('stopped'));
        const result = await processRDSResource(resource, schedule, 'start', credentials, { ...metadata, dryRun: true });
        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(result.action).toBe('start');
        expect(createAuditLog).not.toHaveBeenCalled();
    });

    it('dry-run mode reports the intended stop without mutating or auditing', async () => {
        mockSend.mockResolvedValueOnce(describeResult('available'));
        const result = await processRDSResource(resource, schedule, 'stop', credentials, { ...metadata, dryRun: true });
        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(result.action).toBe('stop');
        expect(createAuditLog).not.toHaveBeenCalled();
    });

    it('returns a failed result and logs a high-severity error when the instance is not found', async () => {
        mockSend.mockResolvedValueOnce({ DBInstances: [] });
        const result = await processRDSResource(resource, schedule, 'start', credentials, metadata);
        expect(result).toEqual(expect.objectContaining({ status: 'failed', error: expect.stringContaining('not found') }));
        expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'scheduler.rds.error', severity: 'high' }));
    });

    it('returns a failed result when the mutation command throws', async () => {
        mockSend.mockResolvedValueOnce(describeResult('stopped')).mockRejectedValueOnce(new Error('AccessDenied'));
        const result = await processRDSResource(resource, schedule, 'start', credentials, metadata);
        expect(result.status).toBe('failed');
        expect(result.error).toBe('AccessDenied');
    });

    it('surfaces a non-Error throw as a stringified message', async () => {
        mockSend.mockRejectedValueOnce('raw failure');
        const result = await processRDSResource(resource, schedule, 'start', credentials, metadata);
        expect(result.error).toBe('raw failure');
    });

    it('restores from a previously recorded last_state on start', async () => {
        mockSend.mockResolvedValueOnce(describeResult('stopped')).mockResolvedValueOnce({});
        const result = await processRDSResource(resource, schedule, 'start', credentials, metadata, { dbInstanceStatus: 'stopped', dbInstanceClass: 'db.t3.micro' });
        expect(result.status).toBe('success');
    });
});

describe('extractRDSIdentifier', () => {
    it('extracts the db identifier from a well-formed ARN', () => {
        expect(extractRDSIdentifier('arn:aws:rds:us-east-1:123:db:my-db')).toBe('my-db');
    });

    it('throws on a malformed ARN', () => {
        expect(() => extractRDSIdentifier('not-an-arn')).toThrow('Invalid RDS ARN format');
    });
});

describe('extractRegionFromArn', () => {
    it('extracts the region segment', () => {
        expect(extractRegionFromArn('arn:aws:rds:us-east-1:123:db:my-db')).toBe('us-east-1');
    });

    it('throws on an ARN with too few segments', () => {
        expect(() => extractRegionFromArn('arn:aws:rds')).toThrow('Invalid ARN format');
    });
});
