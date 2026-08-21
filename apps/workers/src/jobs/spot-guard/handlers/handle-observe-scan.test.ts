// workers/src/jobs/spot-guard/handlers/handle-observe-scan.test.ts
//
// This pass exists because observedStrategy could be wrong forever with no code path that would
// ever correct it: listRestoreCandidates only returns restore-pending or already-On-Demand rows
// with no armed backoff, and the task-state path never calls DescribeServices at all. A healthy
// service on Spot was simply never re-read.
//
// The two properties that make this pass safe are the ones most worth pinning: it must NEVER mutate
// AWS, and one unreachable account must not stop the others being observed.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CapacityProviderStrategyItem } from '../types.js';

const { listManagedServices, upsertObservedService, resolveTenantsForAccount, createSpokeClients, describeServicesBatch } =
    vi.hoisted(() => ({
        listManagedServices: vi.fn(),
        upsertObservedService: vi.fn(),
        resolveTenantsForAccount: vi.fn(),
        createSpokeClients: vi.fn(),
        describeServicesBatch: vi.fn(),
    }));

vi.mock('../services/db-writer.js', async () => {
    const actual = await vi.importActual<typeof import('../services/db-writer.js')>('../services/db-writer.js');
    return { ...actual, listManagedServices, upsertObservedService };
});
vi.mock('../services/account-resolver.js', async () => {
    const actual = await vi.importActual<typeof import('../services/account-resolver.js')>(
        '../services/account-resolver.js',
    );
    return { ...actual, resolveTenantsForAccount };
});
vi.mock('../services/ecs-client.js', async () => {
    const actual = await vi.importActual<typeof import('../services/ecs-client.js')>('../services/ecs-client.js');
    return { ...actual, createSpokeClients, describeServicesBatch };
});

const ecsClientModule = await import('../services/ecs-client.js');
const { handleSpotGuardObserveScan } = await import('./handle-observe-scan.js');

const TENANT = 'tenant-1';
const ACCOUNT = '688849551607';
const CLUSTER = 'stx-kyc-ekyc-ecs-fargate';

const strategy = (spot: number, onDemand: number): CapacityProviderStrategyItem[] => [
    { capacityProvider: 'FARGATE_SPOT', weight: spot, base: 0 },
    { capacityProvider: 'FARGATE', weight: onDemand, base: 0 },
];

const ref = (serviceName: string, over: Record<string, unknown> = {}) => ({
    id: `svc-${serviceName}`,
    tenantId: TENANT,
    accountId: ACCOUNT,
    region: 'ap-south-1',
    clusterName: CLUSTER,
    serviceName,
    capacityState: 'spot',
    ...over,
});

const liveState = (s: CapacityProviderStrategyItem[], over: Record<string, unknown> = {}) => ({
    currentStrategy: s,
    desiredCount: 2,
    runningCount: 2,
    status: 'ACTIVE',
    hasLoadBalancers: false,
    deploymentInProgress: false,
    ...over,
});

beforeEach(() => {
    vi.clearAllMocks();
    resolveTenantsForAccount.mockResolvedValue([
        { tenantId: TENANT, accountId: ACCOUNT, roleArn: 'arn:aws:iam::x:role/y', externalId: 'e', regions: ['ap-south-1'] },
    ]);
    createSpokeClients.mockResolvedValue({ ecs: {}, elbv2: {} });
});

describe('handleSpotGuardObserveScan', () => {
    it('records the live strategy — the case no other path would ever fix', async () => {
        // pf-app in sbx: the registry said 100% On-demand while AWS had it on FARGATE_SPOT w1.
        listManagedServices.mockResolvedValue([ref('pf-app')]);
        describeServicesBatch.mockResolvedValue(new Map([['pf-app', liveState(strategy(1, 0))]]));

        await handleSpotGuardObserveScan({ tenantId: TENANT });

        expect(upsertObservedService).toHaveBeenCalledTimes(1);
        expect(upsertObservedService.mock.calls[0][0]).toMatchObject({
            tenantId: TENANT,
            serviceName: 'pf-app',
            observedStrategy: strategy(1, 0),
        });
    });

    it('records desiredCount and runningCount, which drive the "Stopped" badge', async () => {
        listManagedServices.mockResolvedValue([ref('pf-app')]);
        describeServicesBatch.mockResolvedValue(
            new Map([['pf-app', liveState(strategy(1, 0), { desiredCount: 0, runningCount: 0 })]]),
        );

        await handleSpotGuardObserveScan({ tenantId: TENANT });

        expect(upsertObservedService.mock.calls[0][0]).toMatchObject({ desiredCount: 0, runningCount: 0 });
    });

    it('NEVER calls UpdateService — this pass is read-only', async () => {
        // The property that makes an hourly sweep over live customer services safe at all.
        const spy = vi.spyOn(ecsClientModule, 'updateCapacityProvider');
        listManagedServices.mockResolvedValue([ref('a'), ref('b')]);
        describeServicesBatch.mockResolvedValue(
            new Map([
                ['a', liveState(strategy(1, 0))],
                ['b', liveState(strategy(0, 100))],
            ]),
        );

        await handleSpotGuardObserveScan({ tenantId: TENANT });

        expect(spy).not.toHaveBeenCalled();
    });

    it('preserves capacityState — that column belongs to the task observer', async () => {
        // A strategy change does not move already-running tasks, so the two differ legitimately.
        listManagedServices.mockResolvedValue([ref('a', { capacityState: 'on_demand' })]);
        describeServicesBatch.mockResolvedValue(new Map([['a', liveState(strategy(1, 0))]]));

        await handleSpotGuardObserveScan({ tenantId: TENANT });

        expect(upsertObservedService.mock.calls[0][0].capacityState).toBe('on_demand');
    });

    it("records 'unknown' only when there is no strategy at all", async () => {
        listManagedServices.mockResolvedValue([ref('a', { capacityState: 'spot' })]);
        describeServicesBatch.mockResolvedValue(new Map([['a', liveState([])]]));

        await handleSpotGuardObserveScan({ tenantId: TENANT });

        expect(upsertObservedService.mock.calls[0][0].capacityState).toBe('unknown');
    });

    it('batches one DescribeServices call per cluster', async () => {
        listManagedServices.mockResolvedValue([ref('a'), ref('b'), ref('c')]);
        describeServicesBatch.mockResolvedValue(
            new Map([
                ['a', liveState(strategy(1, 0))],
                ['b', liveState(strategy(1, 0))],
                ['c', liveState(strategy(1, 0))],
            ]),
        );

        await handleSpotGuardObserveScan({ tenantId: TENANT });

        // Three services, one cluster, one call — not three.
        expect(describeServicesBatch).toHaveBeenCalledTimes(1);
        expect(describeServicesBatch.mock.calls[0][2]).toEqual(['a', 'b', 'c']);
        expect(upsertObservedService).toHaveBeenCalledTimes(3);
    });

    it('splits calls per cluster and per account', async () => {
        listManagedServices.mockResolvedValue([
            ref('a'),
            ref('b', { clusterName: 'other-cluster' }),
            ref('c', { accountId: '111111111111' }),
        ]);
        resolveTenantsForAccount.mockImplementation(async (accountId: string) => [
            { tenantId: TENANT, accountId, roleArn: 'arn:aws:iam::x:role/y', externalId: 'e', regions: ['ap-south-1'] },
        ]);
        describeServicesBatch.mockImplementation(async (_ecs: unknown, _cluster: string, names: string[]) =>
            new Map(names.map((n) => [n, liveState(strategy(1, 0))])),
        );

        await handleSpotGuardObserveScan({ tenantId: TENANT });

        expect(describeServicesBatch).toHaveBeenCalledTimes(3);
    });

    describe('resilience', () => {
        it('one unreachable account does not stop the others', async () => {
            // AssumeRole failures are routine — a customer rotating or removing the role. Aborting
            // would mean one bad account freezes every other account's rows.
            listManagedServices.mockResolvedValue([ref('a'), ref('b', { accountId: '111111111111' })]);
            resolveTenantsForAccount.mockImplementation(async (accountId: string) => [
                { tenantId: TENANT, accountId, roleArn: 'arn:aws:iam::x:role/y', externalId: 'e', regions: ['ap-south-1'] },
            ]);
            createSpokeClients.mockImplementation(async (b: { accountId: string }) => {
                if (b.accountId === '111111111111') throw new Error('AccessDenied: cannot assume role');
                return { ecs: {}, elbv2: {} };
            });
            describeServicesBatch.mockResolvedValue(new Map([['a', liveState(strategy(1, 0))]]));

            await handleSpotGuardObserveScan({ tenantId: TENANT });

            expect(upsertObservedService).toHaveBeenCalledTimes(1);
            expect(upsertObservedService.mock.calls[0][0].serviceName).toBe('a');
        });

        it('skips a cluster whose binding is gone rather than throwing', async () => {
            listManagedServices.mockResolvedValue([ref('a')]);
            resolveTenantsForAccount.mockResolvedValue([]); // account deactivated / Spot turned off

            await expect(handleSpotGuardObserveScan({ tenantId: TENANT })).resolves.toBeUndefined();
            expect(createSpokeClients).not.toHaveBeenCalled();
            expect(upsertObservedService).not.toHaveBeenCalled();
        });

        it('ignores a service that no longer exists in AWS', async () => {
            // Deleted between our registry write and this read. Not this pass's job to reconcile.
            listManagedServices.mockResolvedValue([ref('a'), ref('deleted')]);
            describeServicesBatch.mockResolvedValue(new Map([['a', liveState(strategy(1, 0))]]));

            await handleSpotGuardObserveScan({ tenantId: TENANT });

            expect(upsertObservedService).toHaveBeenCalledTimes(1);
            expect(upsertObservedService.mock.calls[0][0].serviceName).toBe('a');
        });

        it('does no AWS work when the tenant has no managed services', async () => {
            listManagedServices.mockResolvedValue([]);

            await handleSpotGuardObserveScan({ tenantId: TENANT });

            expect(resolveTenantsForAccount).not.toHaveBeenCalled();
            expect(createSpokeClients).not.toHaveBeenCalled();
        });

        it('only observes for the tenant that owns the row', async () => {
            // The account is shared with another tenant; we must use OUR binding, not theirs.
            listManagedServices.mockResolvedValue([ref('a')]);
            resolveTenantsForAccount.mockResolvedValue([
                { tenantId: 'other-tenant', accountId: ACCOUNT, roleArn: 'arn:other', externalId: 'x', regions: ['ap-south-1'] },
                { tenantId: TENANT, accountId: ACCOUNT, roleArn: 'arn:ours', externalId: 'e', regions: ['ap-south-1'] },
            ]);
            describeServicesBatch.mockResolvedValue(new Map([['a', liveState(strategy(1, 0))]]));

            await handleSpotGuardObserveScan({ tenantId: TENANT });

            expect(createSpokeClients.mock.calls[0][0].roleArn).toBe('arn:ours');
            expect(upsertObservedService.mock.calls[0][0].tenantId).toBe(TENANT);
        });
    });
});
