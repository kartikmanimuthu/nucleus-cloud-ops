import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('@aws-sdk/client-ec2', () => ({
    EC2Client: vi.fn().mockImplementation(function (this: any) { this.send = mockSend; }),
    DescribeInstancesCommand: vi.fn().mockImplementation(function (this: any, input: unknown) { this.input = input; }),
    StartInstancesCommand: vi.fn().mockImplementation(function (this: any, input: unknown) { this.input = input; }),
    StopInstancesCommand: vi.fn().mockImplementation(function (this: any, input: unknown) { this.input = input; }),
}));
vi.mock('../services/dynamodb-service.js', () => ({ createAuditLog: vi.fn().mockResolvedValue(undefined) }));

import { DescribeInstancesCommand, StartInstancesCommand, StopInstancesCommand } from '@aws-sdk/client-ec2';
import { createAuditLog } from '../services/dynamodb-service.js';
import { processEC2Resource, extractEC2InstanceId, extractRegionFromArn } from './ec2-scheduler.js';
import type { Schedule, ScheduleResource, AssumedCredentials, SchedulerMetadata } from '../types/index.js';

const resource: ScheduleResource = { id: 'i-123', type: 'ec2', name: 'web-1', arn: 'arn:aws:ec2:us-east-1:123:instance/i-123' };
const schedule: Schedule = { scheduleId: 's1', name: 'Nightly', type: 'schedule', starttime: '18:00', endtime: '08:00', timezone: 'UTC', active: true, days: ['Mon'], tenantId: 'tenant-1' };
const credentials: AssumedCredentials = { credentials: { accessKeyId: 'ak', secretAccessKey: 'sk', sessionToken: 'st' }, region: 'us-east-1' };
const metadata: SchedulerMetadata = { account: { name: 'Prod', accountId: 'acc-1' }, region: 'us-east-1', executionId: 'exec-1' };

function describeResult(state: string, instanceType = 't3.micro') {
    return { Reservations: [{ Instances: [{ State: { Name: state }, InstanceType: instanceType, Tags: [], PublicIpAddress: undefined }] }] };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
});

describe('processEC2Resource', () => {
    it('starts a stopped instance, logs a success audit event scoped to the schedule tenant', async () => {
        mockSend.mockResolvedValueOnce(describeResult('stopped')).mockResolvedValueOnce({});

        const result = await processEC2Resource(resource, schedule, 'start', credentials, metadata);

        expect(mockSend).toHaveBeenNthCalledWith(2, expect.any(StartInstancesCommand));
        expect(result).toEqual(expect.objectContaining({ action: 'start', status: 'success', last_state: { instanceState: 'stopped', instanceType: 't3.micro' } }));
        expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
            eventType: 'scheduler.ec2.start', tenantId: 'tenant-1', resourceId: 'i-123', status: 'success',
        }));
    });

    it('stops a running instance and logs a success audit event', async () => {
        mockSend.mockResolvedValueOnce(describeResult('running')).mockResolvedValueOnce({});

        const result = await processEC2Resource(resource, schedule, 'stop', credentials, metadata);

        expect(mockSend).toHaveBeenNthCalledWith(2, expect.any(StopInstancesCommand));
        expect(result.action).toBe('stop');
        expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'scheduler.ec2.stop' }));
    });

    it('skips (no mutation, no audit log) when the instance is already in the desired state', async () => {
        mockSend.mockResolvedValueOnce(describeResult('running'));

        const result = await processEC2Resource(resource, schedule, 'start', credentials, metadata);

        expect(mockSend).toHaveBeenCalledTimes(1); // describe only, no start/stop
        expect(result.action).toBe('skip');
        expect(createAuditLog).not.toHaveBeenCalled();
    });

    it('does not stop an instance that is already stopped', async () => {
        mockSend.mockResolvedValueOnce(describeResult('stopped'));
        const result = await processEC2Resource(resource, schedule, 'stop', credentials, metadata);
        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(result.action).toBe('skip');
    });

    it('dry-run mode reports the intended start action without mutating or auditing', async () => {
        mockSend.mockResolvedValueOnce(describeResult('stopped'));
        const dryRunMetadata: SchedulerMetadata = { ...metadata, dryRun: true };

        const result = await processEC2Resource(resource, schedule, 'start', credentials, dryRunMetadata);

        expect(mockSend).toHaveBeenCalledTimes(1); // describe only
        expect(result).toEqual(expect.objectContaining({ action: 'start', status: 'success' }));
        expect(createAuditLog).not.toHaveBeenCalled();
    });

    it('dry-run mode reports the intended stop action without mutating or auditing', async () => {
        mockSend.mockResolvedValueOnce(describeResult('running'));
        const dryRunMetadata: SchedulerMetadata = { ...metadata, dryRun: true };

        const result = await processEC2Resource(resource, schedule, 'stop', credentials, dryRunMetadata);

        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(result.action).toBe('stop');
        expect(createAuditLog).not.toHaveBeenCalled();
    });

    it('returns a failed result and logs a high-severity error audit event when the instance is not found', async () => {
        mockSend.mockResolvedValueOnce({ Reservations: [] });

        const result = await processEC2Resource(resource, schedule, 'start', credentials, metadata);

        expect(result).toEqual(expect.objectContaining({ status: 'failed', error: expect.stringContaining('not found') }));
        expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
            eventType: 'scheduler.ec2.error', severity: 'high', status: 'error',
        }));
    });

    it('returns a failed result when the StartInstancesCommand itself throws', async () => {
        mockSend.mockResolvedValueOnce(describeResult('stopped')).mockRejectedValueOnce(new Error('AccessDenied'));

        const result = await processEC2Resource(resource, schedule, 'start', credentials, metadata);
        expect(result.status).toBe('failed');
        expect(result.error).toBe('AccessDenied');
    });

    it('surfaces a non-Error throw as a stringified error message', async () => {
        mockSend.mockRejectedValueOnce('raw string failure');
        const result = await processEC2Resource(resource, schedule, 'start', credentials, metadata);
        expect(result.error).toBe('raw string failure');
    });
});

describe('extractEC2InstanceId', () => {
    it('extracts the instance id from a well-formed ARN', () => {
        expect(extractEC2InstanceId('arn:aws:ec2:us-east-1:123:instance/i-0abc123')).toBe('i-0abc123');
    });

    it('throws on a malformed ARN', () => {
        expect(() => extractEC2InstanceId('not-an-arn')).toThrow('Invalid EC2 ARN format');
    });
});

describe('extractRegionFromArn', () => {
    it('extracts the region segment', () => {
        expect(extractRegionFromArn('arn:aws:ec2:us-east-1:123:instance/i-0abc123')).toBe('us-east-1');
    });

    it('throws on an ARN with too few segments', () => {
        expect(() => extractRegionFromArn('arn:aws:ec2')).toThrow('Invalid ARN format');
    });
});
