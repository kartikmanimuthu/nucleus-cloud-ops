import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockEcsSend, mockAsgSend } = vi.hoisted(() => ({ mockEcsSend: vi.fn(), mockAsgSend: vi.fn() }));

vi.mock('@aws-sdk/client-ecs', () => ({
    ECSClient: vi.fn().mockImplementation(function (this: any) { this.send = mockEcsSend; }),
    DescribeServicesCommand: vi.fn().mockImplementation(function (this: any, input: unknown) { this.input = input; }),
    UpdateServiceCommand: vi.fn().mockImplementation(function (this: any, input: unknown) { this.input = input; }),
    ListServicesCommand: vi.fn().mockImplementation(function (this: any, input: unknown) { this.input = input; }),
    DescribeClustersCommand: vi.fn().mockImplementation(function (this: any, input: unknown) { this.input = input; }),
    DescribeCapacityProvidersCommand: vi.fn().mockImplementation(function (this: any, input: unknown) { this.input = input; }),
    ListContainerInstancesCommand: vi.fn().mockImplementation(function (this: any, input: unknown) { this.input = input; }),
    DescribeContainerInstancesCommand: vi.fn().mockImplementation(function (this: any, input: unknown) { this.input = input; }),
}));
vi.mock('@aws-sdk/client-auto-scaling', () => ({
    AutoScalingClient: vi.fn().mockImplementation(function (this: any) { this.send = mockAsgSend; }),
    DescribeAutoScalingGroupsCommand: vi.fn().mockImplementation(function (this: any, input: unknown) { this.input = input; }),
    UpdateAutoScalingGroupCommand: vi.fn().mockImplementation(function (this: any, input: unknown) { this.input = input; }),
    DescribeAutoScalingInstancesCommand: vi.fn().mockImplementation(function (this: any, input: unknown) { this.input = input; }),
    SetInstanceProtectionCommand: vi.fn().mockImplementation(function (this: any, input: unknown) { this.input = input; }),
}));
vi.mock('../services/dynamodb-service.js', () => ({ createAuditLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../scaling-audit/services/platform-recorder.js', () => ({ recordPlatformScalingEvent: vi.fn().mockResolvedValue(undefined) }));

import { createAuditLog } from '../services/dynamodb-service.js';
import { recordPlatformScalingEvent } from '../../scaling-audit/services/platform-recorder.js';
import { processECSResource, extractServiceName, extractClusterName, extractRegionFromArn } from './ecs-scheduler.js';
import type { Schedule, ScheduleResource, AssumedCredentials, SchedulerMetadata } from '../types/index.js';

const resource: ScheduleResource = {
    id: 'my-service', type: 'ecs', name: 'my-service',
    arn: 'arn:aws:ecs:us-east-1:123:service/my-cluster/my-service',
    clusterArn: 'my-cluster',
};
const schedule: Schedule = { scheduleId: 's1', name: 'Nightly', type: 'schedule', starttime: '18:00', endtime: '08:00', timezone: 'UTC', active: true, days: ['Mon'], tenantId: 'tenant-1' };
const credentials: AssumedCredentials = { credentials: { accessKeyId: 'ak', secretAccessKey: 'sk', sessionToken: 'st' }, region: 'us-east-1' };
const metadata: SchedulerMetadata = { account: { name: 'Prod', accountId: 'acc-1' }, region: 'us-east-1', executionId: 'exec-1' };

function describeServicesResult(desiredCount: number, runningCount = desiredCount, pendingCount = 0, status = 'ACTIVE') {
    return { services: [{ desiredCount, runningCount, pendingCount, status, taskDefinition: 'td:1' }] };
}
const emptyListServices = { serviceArns: [] };
const noCapacityProviders = { clusters: [{ capacityProviders: [] }] };
const emptyContainerInstances = { containerInstanceArns: [] };

function idleNoAsgSequence() {
    // listAllServiceArns -> [] => isClusterIdle short-circuits true; getClusterASGs: DescribeClusters, then 2x ListContainerInstances
    mockEcsSend
        .mockResolvedValueOnce(emptyListServices)
        .mockResolvedValueOnce(noCapacityProviders)
        .mockResolvedValueOnce(emptyContainerInstances)
        .mockResolvedValueOnce(emptyContainerInstances);
}

beforeEach(() => {
    vi.clearAllMocks();
    mockEcsSend.mockReset();
    mockAsgSend.mockReset();
});

describe('processECSResource', () => {
    it('returns a failed result when clusterArn is missing and cannot be extracted from the ARN', async () => {
        const badResource: ScheduleResource = { id: 'x', type: 'ecs', arn: 'arn:aws:ecs:us-east-1:123:not-a-service-arn' };
        const result = await processECSResource(badResource, schedule, 'start', credentials, metadata);
        expect(result).toEqual(expect.objectContaining({ status: 'failed', clusterArn: 'unknown', error: expect.stringContaining('missing clusterArn') }));
        expect(mockEcsSend).not.toHaveBeenCalled();
    });

    it('extracts clusterArn from the ARN when resource.clusterArn is absent', async () => {
        const noClusterArn: ScheduleResource = { id: 'my-service', type: 'ecs', arn: 'arn:aws:ecs:us-east-1:123:service/my-cluster/my-service' };
        mockEcsSend.mockResolvedValueOnce(describeServicesResult(1));
        idleNoAsgSequence();

        const result = await processECSResource(noClusterArn, schedule, 'start', credentials, metadata, 1);
        expect(result.clusterArn).toBe('my-cluster');
    });

    it('returns a failed result and logs a high-severity error when the service is not found', async () => {
        mockEcsSend.mockResolvedValueOnce({ services: [] });
        const result = await processECSResource(resource, schedule, 'start', credentials, metadata);
        expect(result).toEqual(expect.objectContaining({ status: 'failed', error: expect.stringContaining('not found') }));
        expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'scheduler.ecs.error', severity: 'high', tenantId: 'tenant-1' }));
        expect(recordPlatformScalingEvent).toHaveBeenCalledWith(expect.objectContaining({ scope: 'ecs', statusCode: 'Failed' }));
    });

    it('dry-run stop reports the intended stop without mutating when desiredCount > 0', async () => {
        mockEcsSend.mockResolvedValueOnce(describeServicesResult(2));
        const result = await processECSResource(resource, schedule, 'stop', credentials, { ...metadata, dryRun: true });
        expect(mockEcsSend).toHaveBeenCalledTimes(1);
        expect(result.action).toBe('stop');
        expect(createAuditLog).not.toHaveBeenCalled();
    });

    it('dry-run stop reports skip when already at 0', async () => {
        mockEcsSend.mockResolvedValueOnce(describeServicesResult(0));
        const result = await processECSResource(resource, schedule, 'stop', credentials, { ...metadata, dryRun: true });
        expect(result.action).toBe('skip');
    });

    it('dry-run start reports the intended start when not at the target desiredCount', async () => {
        mockEcsSend.mockResolvedValueOnce(describeServicesResult(0));
        const result = await processECSResource(resource, schedule, 'start', credentials, { ...metadata, dryRun: true }, 3);
        expect(mockEcsSend).toHaveBeenCalledTimes(1);
        expect(result.action).toBe('start');
        expect(result.last_state.desiredCount).toBe(0);
    });

    it('stops a running service on an idle cluster with no backing ASGs', async () => {
        mockEcsSend.mockResolvedValueOnce(describeServicesResult(2)).mockResolvedValueOnce({});
        idleNoAsgSequence();

        const result = await processECSResource(resource, schedule, 'stop', credentials, metadata);

        expect(result).toEqual(expect.objectContaining({ action: 'stop', status: 'success' }));
        expect(result.last_state.asg_state).toBeUndefined();
        expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'scheduler.ecs.stop', tenantId: 'tenant-1' }));
        expect(recordPlatformScalingEvent).toHaveBeenCalledWith(expect.objectContaining({ scope: 'ecs', desiredBefore: 2, desiredAfter: 0 }));
    });

    it('stops the backing ASG when the cluster becomes idle, even if the service was already at 0', async () => {
        mockEcsSend
            .mockResolvedValueOnce(describeServicesResult(0)) // primary describe, already 0 -> no UpdateServiceCommand
            .mockResolvedValueOnce(emptyListServices) // isClusterIdle -> idle
            .mockResolvedValueOnce({ clusters: [{ capacityProviders: ['my-cp'] }] }) // getClusterASGs: has a custom CP
            .mockResolvedValueOnce({ capacityProviders: [{ name: 'my-cp', autoScalingGroupProvider: { autoScalingGroupArn: 'arn:aws:autoscaling:us-east-1:123:autoScalingGroup:uuid:autoScalingGroupName/backing-asg' } }] })
            .mockResolvedValueOnce(emptyContainerInstances)
            .mockResolvedValueOnce(emptyContainerInstances);
        mockAsgSend
            .mockResolvedValueOnce({ AutoScalingGroups: [{ MinSize: 1, MaxSize: 3, DesiredCapacity: 2, Instances: [] }] })
            .mockResolvedValueOnce({});

        const result = await processECSResource(resource, schedule, 'stop', credentials, metadata);

        expect(result.action).toBe('stop');
        expect(result.last_state.asg_state).toEqual([{ name: 'backing-asg', minSize: 1, maxSize: 3, desiredCapacity: 2 }]);
        expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'scheduler.asg.stop', resourceId: 'backing-asg' }));
        expect(recordPlatformScalingEvent).toHaveBeenCalledWith(expect.objectContaining({ scope: 'asg', resourceId: 'backing-asg', desiredBefore: 2, desiredAfter: 0 }));
    });

    it('disables scale-in protection on protected instances before stopping the backing ASG', async () => {
        mockEcsSend
            .mockResolvedValueOnce(describeServicesResult(0))
            .mockResolvedValueOnce(emptyListServices)
            .mockResolvedValueOnce(noCapacityProviders)
            .mockResolvedValueOnce({ containerInstanceArns: ['ci-1'] })
            .mockResolvedValueOnce(emptyContainerInstances)
            .mockResolvedValueOnce({ containerInstances: [{ ec2InstanceId: 'i-1' }] });
        mockAsgSend
            .mockResolvedValueOnce({ AutoScalingInstances: [{ AutoScalingGroupName: 'backing-asg' }] })
            .mockResolvedValueOnce({ AutoScalingGroups: [{ MinSize: 1, MaxSize: 3, DesiredCapacity: 2, Instances: [{ InstanceId: 'i-1', ProtectedFromScaleIn: true }] }] })
            .mockResolvedValueOnce({}) // SetInstanceProtectionCommand
            .mockResolvedValueOnce({}); // UpdateAutoScalingGroupCommand stop

        const result = await processECSResource(resource, schedule, 'stop', credentials, metadata);

        expect(result.action).toBe('stop');
        const protectCall = mockAsgSend.mock.calls[2][0];
        expect(protectCall.input).toEqual({ AutoScalingGroupName: 'backing-asg', InstanceIds: ['i-1'], ProtectedFromScaleIn: false });
    });

    it('does not attempt ASG shutdown when the cluster is not idle', async () => {
        mockEcsSend
            .mockResolvedValueOnce(describeServicesResult(2))
            .mockResolvedValueOnce({}) // update service (stop)
            .mockResolvedValueOnce({ serviceArns: ['other-service'] }) // listAllServiceArns
            .mockResolvedValueOnce({ services: [{ serviceName: 'other-service', desiredCount: 1 }] }); // still active -> not idle

        const result = await processECSResource(resource, schedule, 'stop', credentials, metadata);

        expect(result.action).toBe('stop');
        expect(result.last_state.asg_state).toBeUndefined();
        expect(mockAsgSend).not.toHaveBeenCalled();
    });

    it('reports skip when the service was already at 0 and the cluster is not idle', async () => {
        mockEcsSend
            .mockResolvedValueOnce(describeServicesResult(0))
            .mockResolvedValueOnce({ serviceArns: ['other-service'] })
            .mockResolvedValueOnce({ services: [{ serviceName: 'other-service', desiredCount: 1 }] });

        const result = await processECSResource(resource, schedule, 'stop', credentials, metadata);
        expect(result.action).toBe('skip');
        expect(createAuditLog).not.toHaveBeenCalled();
    });

    it('skips starting a service already at the target desiredCount', async () => {
        mockEcsSend.mockResolvedValueOnce(describeServicesResult(3));
        const result = await processECSResource(resource, schedule, 'start', credentials, metadata, 3);
        expect(mockEcsSend).toHaveBeenCalledTimes(1);
        expect(result.action).toBe('skip');
        expect(createAuditLog).not.toHaveBeenCalled();
    });

    it('restores backing ASGs from lastAsgState before starting the service', async () => {
        mockEcsSend.mockResolvedValueOnce(describeServicesResult(0)).mockResolvedValueOnce({});
        mockAsgSend.mockResolvedValueOnce({});

        const lastAsgState = [{ name: 'backing-asg', minSize: 1, maxSize: 3, desiredCapacity: 2 }];
        const result = await processECSResource(resource, schedule, 'start', credentials, metadata, 2, lastAsgState);

        expect(result.action).toBe('start');
        const restoreCall = mockAsgSend.mock.calls[0][0];
        expect(restoreCall.input).toEqual({ AutoScalingGroupName: 'backing-asg', MinSize: 1, MaxSize: 3, DesiredCapacity: 2 });
        expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'scheduler.asg.start', resourceId: 'backing-asg' }));
        expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'scheduler.ecs.start' }));
        expect(recordPlatformScalingEvent).toHaveBeenCalledWith(expect.objectContaining({ scope: 'asg', resourceId: 'backing-asg', desiredAfter: 2 }));
        expect(recordPlatformScalingEvent).toHaveBeenCalledWith(expect.objectContaining({ scope: 'ecs', desiredAfter: 2 }));
    });

    it('applies a fallback default capacity to a backing ASG at 0 when no lastAsgState was captured', async () => {
        mockEcsSend
            .mockResolvedValueOnce(describeServicesResult(0))
            .mockResolvedValueOnce(noCapacityProviders)
            .mockResolvedValueOnce({ containerInstanceArns: ['ci-1'] })
            .mockResolvedValueOnce(emptyContainerInstances)
            .mockResolvedValueOnce({ containerInstances: [{ ec2InstanceId: 'i-1' }] })
            .mockResolvedValueOnce({}); // final UpdateServiceCommand start
        mockAsgSend
            .mockResolvedValueOnce({ AutoScalingInstances: [{ AutoScalingGroupName: 'backing-asg' }] })
            .mockResolvedValueOnce({ AutoScalingGroups: [{ MinSize: 0, MaxSize: 0, DesiredCapacity: 0 }] })
            .mockResolvedValueOnce({}); // UpdateAutoScalingGroupCommand fallback

        const result = await processECSResource(resource, schedule, 'start', credentials, metadata, 1);

        expect(result.action).toBe('start');
        const fallbackCall = mockAsgSend.mock.calls[2][0];
        expect(fallbackCall.input).toEqual({ AutoScalingGroupName: 'backing-asg', MinSize: 1, MaxSize: 1, DesiredCapacity: 1 });
        expect(createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'scheduler.asg.start', status: 'warning' }));
        expect(recordPlatformScalingEvent).toHaveBeenCalledWith(expect.objectContaining({ rawPayload: { usedFallbackDefaults: true } }));
    });

    it('starts the service directly when there is no lastAsgState and no backing ASGs', async () => {
        mockEcsSend
            .mockResolvedValueOnce(describeServicesResult(0))
            .mockResolvedValueOnce(noCapacityProviders)
            .mockResolvedValueOnce(emptyContainerInstances)
            .mockResolvedValueOnce(emptyContainerInstances)
            .mockResolvedValueOnce({});

        const result = await processECSResource(resource, schedule, 'start', credentials, metadata);
        expect(mockAsgSend).not.toHaveBeenCalled();
        expect(result.action).toBe('start');
        expect(result.last_state.desiredCount).toBe(0);
    });

    it('returns a failed result and records a Failed scaling event when the stop mutation throws', async () => {
        mockEcsSend.mockResolvedValueOnce(describeServicesResult(2)).mockRejectedValueOnce(new Error('AccessDenied'));
        const result = await processECSResource(resource, schedule, 'stop', credentials, metadata);
        expect(result.status).toBe('failed');
        expect(result.error).toBe('AccessDenied');
        expect(recordPlatformScalingEvent).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 'Failed', statusMessage: 'AccessDenied' }));
    });

    it('surfaces a non-Error throw as a stringified message', async () => {
        mockEcsSend.mockRejectedValueOnce('raw failure');
        const result = await processECSResource(resource, schedule, 'start', credentials, metadata);
        expect(result.error).toBe('raw failure');
    });
});

describe('extractServiceName', () => {
    it('extracts the service name from a cluster-qualified ARN', () => {
        expect(extractServiceName('arn:aws:ecs:us-east-1:123:service/my-cluster/my-service')).toBe('my-service');
    });

    it('falls back to the segment after service/ when no cluster segment is present', () => {
        expect(extractServiceName('arn:aws:ecs:us-east-1:123:service/my-service')).toBe('my-service');
    });

    it('throws on a malformed ARN', () => {
        expect(() => extractServiceName('not-an-arn')).toThrow('Invalid ECS service ARN format');
    });
});

describe('extractClusterName', () => {
    it('extracts the cluster name from a well-formed service ARN', () => {
        expect(extractClusterName('arn:aws:ecs:us-east-1:123:service/my-cluster/my-service')).toBe('my-cluster');
    });

    it('returns null when the ARN has no cluster segment', () => {
        expect(extractClusterName('arn:aws:ecs:us-east-1:123:service/my-service')).toBeNull();
    });
});

describe('extractRegionFromArn', () => {
    it('extracts the region segment', () => {
        expect(extractRegionFromArn('arn:aws:ecs:us-east-1:123:service/c/s')).toBe('us-east-1');
    });

    it('throws on an ARN with too few segments', () => {
        expect(() => extractRegionFromArn('arn:aws:ecs')).toThrow('Invalid ARN format');
    });
});
