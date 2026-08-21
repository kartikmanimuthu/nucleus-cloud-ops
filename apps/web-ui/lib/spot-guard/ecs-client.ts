// web-ui/lib/spot-guard/ecs-client.ts
//
// Cross-account ECS access for the user-initiated Spot Guard actions (enable / disable).
// Structurally mirrors lib/certificate-aws.ts, which is the established pattern for web-ui
// reaching into a customer account.
//
// STS AssumeRole only — never hardcoded credentials, per the repo-wide rule.
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import {
    ECSClient,
    DescribeServicesCommand,
    DescribeClustersCommand,
    UpdateServiceCommand,
    type Service,
} from '@aws-sdk/client-ecs';
import { env } from '@/env';
import type { CapacityProviderStrategyItem } from '@/lib/db/repositories/spot-guard/interface';

const DEFAULT_REGION = env.AWS_REGION || 'ap-south-1';

export interface AssumedAccount {
    accountId: string;
    roleArn: string;
    externalId?: string | null;
}

/** Assume the customer's NucleusAccess role and return an ECS client for one region. */
export async function ecsClientFor(account: AssumedAccount, region: string): Promise<ECSClient> {
    const sts = new STSClient({ region: DEFAULT_REGION });
    const res = await sts.send(
        new AssumeRoleCommand({
            RoleArn: account.roleArn,
            RoleSessionName: `NucleusSpotGuard-${account.accountId}`,
            DurationSeconds: 3600,
            ...(account.externalId ? { ExternalId: account.externalId } : {}),
        }),
    );
    if (!res.Credentials) throw new Error('Failed to obtain temporary credentials');

    return new ECSClient({
        region,
        credentials: {
            accessKeyId: res.Credentials.AccessKeyId!,
            secretAccessKey: res.Credentials.SecretAccessKey!,
            sessionToken: res.Credentials.SessionToken!,
        },
    });
}

export interface LiveService {
    raw: Service;
    strategy: CapacityProviderStrategyItem[];
    desiredCount: number;
    runningCount: number;
    status: string;
    deploymentInProgress: boolean;
}

export async function describeService(
    ecs: ECSClient,
    clusterName: string,
    serviceName: string,
): Promise<LiveService | null> {
    const res = await ecs.send(new DescribeServicesCommand({ cluster: clusterName, services: [serviceName] }));
    const svc = res.services?.[0];
    if (!svc) return null;
    return {
        raw: svc,
        strategy: (svc.capacityProviderStrategy ?? []).map((cp) => ({
            capacityProvider: cp.capacityProvider ?? '',
            weight: cp.weight ?? 0,
            base: cp.base ?? 0,
        })),
        desiredCount: svc.desiredCount ?? 0,
        runningCount: svc.runningCount ?? 0,
        status: svc.status ?? 'UNKNOWN',
        deploymentInProgress: (svc.deployments ?? []).some((d) => d.rolloutState === 'IN_PROGRESS'),
    };
}

/**
 * Capacity providers registered on the cluster.
 *
 * Needed before enabling Spot on a service whose strategy has none: UpdateService rejects a
 * provider the cluster does not offer, so without this check the user would get an opaque
 * AWS error instead of an actionable 409.
 */
export async function clusterCapacityProviders(ecs: ECSClient, clusterName: string): Promise<string[]> {
    const res = await ecs.send(new DescribeClustersCommand({ clusters: [clusterName] }));
    return res.clusters?.[0]?.capacityProviders ?? [];
}

/**
 * Apply a capacity provider strategy.
 *
 * forceNewDeployment is required — without it ECS applies the new strategy only to
 * newly-placed tasks, so an already-placed service would never actually move. It is also
 * why callers must be confirmation-gated: this bounces every task in the service.
 */
export async function updateCapacityProvider(
    ecs: ECSClient,
    clusterName: string,
    serviceName: string,
    strategy: CapacityProviderStrategyItem[],
): Promise<void> {
    await ecs.send(
        new UpdateServiceCommand({
            cluster: clusterName,
            service: serviceName,
            capacityProviderStrategy: strategy.map((cp) => ({
                capacityProvider: cp.capacityProvider,
                weight: cp.weight ?? 0,
                base: cp.base ?? 0,
            })),
            forceNewDeployment: true,
        }),
    );
}
