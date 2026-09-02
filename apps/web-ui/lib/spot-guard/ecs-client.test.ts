import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockStsSend, mockEcsSend } = vi.hoisted(() => ({
    mockStsSend: vi.fn(),
    mockEcsSend: vi.fn(),
}));

vi.mock('@aws-sdk/client-sts', () => ({
    STSClient: vi.fn().mockImplementation(function (this: any) { this.send = mockStsSend; }),
    AssumeRoleCommand: vi.fn().mockImplementation(function (this: any, input: unknown) { this.input = input; }),
}));

vi.mock('@aws-sdk/client-ecs', () => ({
    ECSClient: vi.fn().mockImplementation(function (this: any, config: unknown) { this.config = config; this.send = mockEcsSend; }),
    DescribeServicesCommand: vi.fn().mockImplementation(function (this: any, input: unknown) { this.input = input; }),
    DescribeClustersCommand: vi.fn().mockImplementation(function (this: any, input: unknown) { this.input = input; }),
    UpdateServiceCommand: vi.fn().mockImplementation(function (this: any, input: unknown) { this.input = input; }),
}));

import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { ECSClient } from '@aws-sdk/client-ecs';
import { ecsClientFor, describeService, clusterCapacityProviders, updateCapacityProvider } from './ecs-client';

const ACCOUNT = { accountId: '111111111111', roleArn: 'arn:aws:iam::111111111111:role/NucleusAccess' };

describe('ecsClientFor', () => {
    beforeEach(() => vi.clearAllMocks());

    it('assumes the account role and returns an ECS client with the temp credentials', async () => {
        const expiredCreds = { AccessKeyId: 'AK', SecretAccessKey: 'SK', SessionToken: 'ST' };
        mockStsSend.mockResolvedValueOnce({ Credentials: expiredCreds });

        const ecs = await ecsClientFor(ACCOUNT, 'us-east-1');

        expect(AssumeRoleCommand).toHaveBeenCalledWith(expect.objectContaining({
            RoleArn: ACCOUNT.roleArn,
            RoleSessionName: 'NucleusSpotGuard-111111111111',
            DurationSeconds: 3600,
        }));
        expect(ecs).toBeInstanceOf(ECSClient);
        expect((ecs as any).config).toEqual(expect.objectContaining({
            region: 'us-east-1',
            credentials: { accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'ST' },
        }));
    });

    it('includes ExternalId in the AssumeRole request when provided', async () => {
        mockStsSend.mockResolvedValueOnce({ Credentials: { AccessKeyId: 'AK', SecretAccessKey: 'SK', SessionToken: 'ST' } });
        await ecsClientFor({ ...ACCOUNT, externalId: 'ext-123' }, 'us-east-1');
        expect(AssumeRoleCommand).toHaveBeenCalledWith(expect.objectContaining({ ExternalId: 'ext-123' }));
    });

    it('omits ExternalId when not provided', async () => {
        mockStsSend.mockResolvedValueOnce({ Credentials: { AccessKeyId: 'AK', SecretAccessKey: 'SK', SessionToken: 'ST' } });
        await ecsClientFor(ACCOUNT, 'us-east-1');
        const input = vi.mocked(AssumeRoleCommand).mock.calls[0][0] as any;
        expect(input.ExternalId).toBeUndefined();
    });

    it('throws when STS returns no credentials', async () => {
        mockStsSend.mockResolvedValueOnce({});
        await expect(ecsClientFor(ACCOUNT, 'us-east-1')).rejects.toThrow('Failed to obtain temporary credentials');
    });
});

describe('describeService', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns null when the service is not found', async () => {
        mockEcsSend.mockResolvedValueOnce({ services: [] });
        const ecs = new ECSClient({} as any);
        expect(await describeService(ecs, 'cluster1', 'service1')).toBeNull();
    });

    it('maps a live service, defaulting missing fields', async () => {
        mockEcsSend.mockResolvedValueOnce({
            services: [{
                capacityProviderStrategy: [{ capacityProvider: 'FARGATE_SPOT', weight: 1, base: 0 }],
                desiredCount: 3, runningCount: 3, status: 'ACTIVE',
                deployments: [{ rolloutState: 'COMPLETED' }],
            }],
        });
        const ecs = new ECSClient({} as any);
        const result = await describeService(ecs, 'cluster1', 'service1');

        expect(result).toEqual(expect.objectContaining({
            strategy: [{ capacityProvider: 'FARGATE_SPOT', weight: 1, base: 0 }],
            desiredCount: 3, runningCount: 3, status: 'ACTIVE', deploymentInProgress: false,
        }));
    });

    it('defaults strategy/counts/status when the service payload omits them', async () => {
        mockEcsSend.mockResolvedValueOnce({ services: [{}] });
        const ecs = new ECSClient({} as any);
        const result = await describeService(ecs, 'cluster1', 'service1');

        expect(result).toEqual(expect.objectContaining({
            strategy: [], desiredCount: 0, runningCount: 0, status: 'UNKNOWN', deploymentInProgress: false,
        }));
    });

    it('detects an in-progress deployment', async () => {
        mockEcsSend.mockResolvedValueOnce({
            services: [{ deployments: [{ rolloutState: 'IN_PROGRESS' }] }],
        });
        const ecs = new ECSClient({} as any);
        const result = await describeService(ecs, 'cluster1', 'service1');
        expect(result?.deploymentInProgress).toBe(true);
    });

    it('defaults capacityProviderStrategy fields when partially present', async () => {
        mockEcsSend.mockResolvedValueOnce({ services: [{ capacityProviderStrategy: [{}] }] });
        const ecs = new ECSClient({} as any);
        const result = await describeService(ecs, 'cluster1', 'service1');
        expect(result?.strategy).toEqual([{ capacityProvider: '', weight: 0, base: 0 }]);
    });
});

describe('clusterCapacityProviders', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns the cluster capacity providers', async () => {
        mockEcsSend.mockResolvedValueOnce({ clusters: [{ capacityProviders: ['FARGATE', 'FARGATE_SPOT'] }] });
        const ecs = new ECSClient({} as any);
        expect(await clusterCapacityProviders(ecs, 'cluster1')).toEqual(['FARGATE', 'FARGATE_SPOT']);
    });

    it('returns an empty array when the cluster or its providers are missing', async () => {
        mockEcsSend.mockResolvedValueOnce({ clusters: [] });
        const ecs = new ECSClient({} as any);
        expect(await clusterCapacityProviders(ecs, 'missing')).toEqual([]);
    });
});

describe('updateCapacityProvider', () => {
    beforeEach(() => vi.clearAllMocks());

    it('sends an UpdateService command with forceNewDeployment and defaulted weight/base', async () => {
        const { UpdateServiceCommand } = await import('@aws-sdk/client-ecs');
        mockEcsSend.mockResolvedValueOnce({});
        const ecs = new ECSClient({} as any);

        await updateCapacityProvider(ecs, 'cluster1', 'service1', [{ capacityProvider: 'FARGATE_SPOT' } as any]);

        expect(UpdateServiceCommand).toHaveBeenCalledWith({
            cluster: 'cluster1', service: 'service1',
            capacityProviderStrategy: [{ capacityProvider: 'FARGATE_SPOT', weight: 0, base: 0 }],
            forceNewDeployment: true,
        });
        expect(mockEcsSend).toHaveBeenCalled();
    });
});
