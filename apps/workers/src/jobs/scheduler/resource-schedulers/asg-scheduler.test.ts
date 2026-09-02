import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('@aws-sdk/client-auto-scaling', () => ({
    AutoScalingClient: vi.fn().mockImplementation(function (this: any) { this.send = mockSend; }),
    DescribeAutoScalingGroupsCommand: vi.fn().mockImplementation(function (this: any, input: unknown) { this.input = input; }),
    UpdateAutoScalingGroupCommand: vi.fn().mockImplementation(function (this: any, input: unknown) { this.input = input; }),
}));
vi.mock('../services/dynamodb-service.js', () => ({ createAuditLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../scaling-audit/services/platform-recorder.js', () => ({ recordPlatformScalingEvent: vi.fn().mockResolvedValue(undefined) }));

import { UpdateAutoScalingGroupCommand } from '@aws-sdk/client-auto-scaling';
import { createAuditLog } from '../services/dynamodb-service.js';
import { recordPlatformScalingEvent } from '../../scaling-audit/services/platform-recorder.js';
import { processASGResource, extractASGName, extractRegionFromArn } from './asg-scheduler.js';
import type { Schedule, ScheduleResource, AssumedCredentials, SchedulerMetadata } from '../types/index.js';

const resource: ScheduleResource = { id: 'my-asg', type: 'asg', name: 'my-asg', arn: 'arn:aws:autoscaling:us-east-1:123:autoScalingGroup:uuid:autoScalingGroupName/my-asg' };
const schedule: Schedule = { scheduleId: 's1', name: 'Nightly', type: 'schedule', starttime: '18:00', endtime: '08:00', timezone: 'UTC', active: true, days: ['Mon'], tenantId: 'tenant-1' };
const credentials: AssumedCredentials = { credentials: { accessKeyId: 'ak', secretAccessKey: 'sk', sessionToken: 'st' }, region: 'us-east-1' };
const metadata: SchedulerMetadata = { account: { name: 'Prod', accountId: 'acc-1' }, region: 'us-east-1', executionId: 'exec-1' };

function describeResult(minSize: number, maxSize: number, desiredCapacity: number, instances: Array<{ InstanceId: string; LifecycleState: string }> = []) {
    return { AutoScalingGroups: [{ MinSize: minSize, MaxSize: maxSize, DesiredCapacity: desiredCapacity, Instances: instances }] };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
});

describe('processASGResource', () => {
    it('stops a running ASG, saving current capacity to last_state, and records both audit systems', async () => {
        mockSend.mockResolvedValueOnce(describeResult(2, 5, 3)).mockResolvedValueOnce({});

        const result = await processASGResource(resource, schedule, 'stop', credentials, metadata);

        expect(mockSend).toHaveBeenNthCalledWith(2, expect.any(UpdateAutoScalingGroupCommand));
        const updateInput = (mockSend.mock.calls[1][0] as any).input;
        expect(updateInput).toEqual({ AutoScalingGroupName: 'my-asg', MinSize: 0, MaxSize: 0, DesiredCapacity: 0 });
        expect(result).toEqual(expect.objectContaining({ action: 'stop', status: 'success', last_state: { minSize: 2, maxSize: 5, desiredCapacity: 3 } }));
        expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'scheduler.asg.stop', tenantId: 'tenant-1' }));
        expect(recordPlatformScalingEvent).toHaveBeenCalledWith(expect.objectContaining({
            scope: 'asg', resourceId: 'my-asg', desiredBefore: 3, desiredAfter: 0, minBefore: 2, maxBefore: 5, minAfter: 0, maxAfter: 0,
        }));
    });

    it('starts a stopped ASG restoring the previously saved capacity from lastState', async () => {
        mockSend.mockResolvedValueOnce(describeResult(0, 0, 0)).mockResolvedValueOnce({});

        const result = await processASGResource(resource, schedule, 'start', credentials, metadata, { minSize: 2, maxSize: 5, desiredCapacity: 3 });

        const updateInput = (mockSend.mock.calls[1][0] as any).input;
        expect(updateInput).toEqual({ AutoScalingGroupName: 'my-asg', MinSize: 2, MaxSize: 5, DesiredCapacity: 3 });
        expect(result.action).toBe('start');
        expect(recordPlatformScalingEvent).toHaveBeenCalledWith(expect.objectContaining({
            desiredAfter: 3, minAfter: 2, maxAfter: 5, rawPayload: { usedFallbackDefaults: false },
        }));
    });

    it('falls back to 1/1/1 when starting with no lastState, flagging usedFallbackDefaults', async () => {
        mockSend.mockResolvedValueOnce(describeResult(0, 0, 0)).mockResolvedValueOnce({});

        await processASGResource(resource, schedule, 'start', credentials, metadata);

        const updateInput = (mockSend.mock.calls[1][0] as any).input;
        expect(updateInput).toEqual({ AutoScalingGroupName: 'my-asg', MinSize: 1, MaxSize: 1, DesiredCapacity: 1 });
        expect(recordPlatformScalingEvent).toHaveBeenCalledWith(expect.objectContaining({ rawPayload: { usedFallbackDefaults: true } }));
    });

    it('skips when stopping an ASG that is already at 0/0/0', async () => {
        mockSend.mockResolvedValueOnce(describeResult(0, 0, 0));
        const result = await processASGResource(resource, schedule, 'stop', credentials, metadata);
        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(result.action).toBe('skip');
        expect(createAuditLog).not.toHaveBeenCalled();
        expect(recordPlatformScalingEvent).not.toHaveBeenCalled();
    });

    it('skips when starting an ASG that already has capacity', async () => {
        mockSend.mockResolvedValueOnce(describeResult(2, 5, 3));
        const result = await processASGResource(resource, schedule, 'start', credentials, metadata);
        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(result.action).toBe('skip');
    });

    it('dry-run mode reports the intended stop without mutating or recording anything', async () => {
        mockSend.mockResolvedValueOnce(describeResult(2, 5, 3));
        const result = await processASGResource(resource, schedule, 'stop', credentials, { ...metadata, dryRun: true });
        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(result.action).toBe('stop');
        expect(createAuditLog).not.toHaveBeenCalled();
        expect(recordPlatformScalingEvent).not.toHaveBeenCalled();
    });

    it('dry-run mode reports the intended start without mutating or recording anything', async () => {
        mockSend.mockResolvedValueOnce(describeResult(0, 0, 0));
        const result = await processASGResource(resource, schedule, 'start', credentials, { ...metadata, dryRun: true }, { minSize: 2, maxSize: 5, desiredCapacity: 3 });
        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(result.action).toBe('start');
        expect(createAuditLog).not.toHaveBeenCalled();
        expect(recordPlatformScalingEvent).not.toHaveBeenCalled();
    });

    it('returns a failed result and records both audit systems when the ASG is not found', async () => {
        mockSend.mockResolvedValueOnce({ AutoScalingGroups: [] });

        const result = await processASGResource(resource, schedule, 'stop', credentials, metadata);

        expect(result).toEqual(expect.objectContaining({ status: 'failed', error: expect.stringContaining('not found') }));
        expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'scheduler.asg.error', severity: 'high' }));
        expect(recordPlatformScalingEvent).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 'Failed' }));
    });

    it('returns a failed result when the update command throws', async () => {
        mockSend.mockResolvedValueOnce(describeResult(2, 5, 3)).mockRejectedValueOnce(new Error('AccessDenied'));
        const result = await processASGResource(resource, schedule, 'stop', credentials, metadata);
        expect(result.status).toBe('failed');
        expect(result.error).toBe('AccessDenied');
    });
});

describe('extractASGName', () => {
    it('extracts the ASG name from the autoScalingGroupName/ segment', () => {
        expect(extractASGName('arn:aws:autoscaling:us-east-1:123:autoScalingGroup:uuid:autoScalingGroupName/my-asg')).toBe('my-asg');
    });

    it('falls back to the last path segment when the named format is absent', () => {
        expect(extractASGName('some/path/my-asg')).toBe('my-asg');
    });

    it('returns the input unchanged when it has no path separator at all', () => {
        expect(extractASGName('my-asg')).toBe('my-asg');
    });
});

describe('extractRegionFromArn', () => {
    it('extracts the region segment', () => {
        expect(extractRegionFromArn('arn:aws:autoscaling:us-east-1:123:autoScalingGroup:uuid')).toBe('us-east-1');
    });

    it('throws on an ARN with too few segments', () => {
        expect(() => extractRegionFromArn('arn:aws:autoscaling')).toThrow('Invalid ARN format');
    });
});
