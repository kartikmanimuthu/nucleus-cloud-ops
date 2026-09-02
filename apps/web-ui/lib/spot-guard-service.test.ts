import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/repository-factory', () => ({
    getSpotGuardRepository: vi.fn(),
    getAccountRepository: vi.fn(),
}));
vi.mock('@/lib/audit-service', () => ({ AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('@/lib/boss-client', () => ({ getBoss: vi.fn() }));
vi.mock('@/lib/spot-guard/ecs-client', () => ({
    ecsClientFor: vi.fn(),
    describeService: vi.fn(),
    clusterCapacityProviders: vi.fn(),
    updateCapacityProvider: vi.fn(),
}));
// strategy.ts is left unmocked — pure logic, real implementation exercised.

import { getSpotGuardRepository, getAccountRepository } from '@/lib/db/repository-factory';
import { AuditService } from '@/lib/audit-service';
import { getBoss } from '@/lib/boss-client';
import { ecsClientFor, describeService, clusterCapacityProviders, updateCapacityProvider } from '@/lib/spot-guard/ecs-client';
import { SpotGuardService, SpotGuardErrors } from './spot-guard-service';

const ON_DEMAND_ONLY = [{ capacityProvider: 'FARGATE', weight: 1, base: 0 }];
const SPOT_FIRST = [{ capacityProvider: 'FARGATE_SPOT', weight: 100, base: 0 }];

const SERVICE_ROW = {
    id: 'sg-1', tenantId: 't1', accountId: 'acc-1', region: 'ap-south-1', clusterName: 'cluster-a',
    serviceName: 'svc-a', desiredStrategy: ON_DEMAND_ONLY, observedStrategy: ON_DEMAND_ONLY,
};

const ACCOUNT_ROW = { accountId: 'acc-1', roleArn: 'arn:aws:iam::1:role/R', externalId: null, spotAutomationEnabled: true };

const LIVE = {
    strategy: ON_DEMAND_ONLY, deploymentInProgress: false, desiredCount: 2, runningCount: 2,
    raw: { clusterArn: 'arn:cluster', serviceArn: 'arn:service' },
};

let mockRepo: any;

beforeEach(() => {
    vi.clearAllMocks();
    mockRepo = {
        getFacets: vi.fn(), listServices: vi.fn(), listEvents: vi.fn(), listEligibleServices: vi.fn(),
        getSummary: vi.fn(), getHoursReport: vi.fn(), getService: vi.fn(), findServiceByTarget: vi.fn(),
        upsertService: vi.fn(), setManagementState: vi.fn(), recordEvent: vi.fn().mockResolvedValue({}),
    };
    vi.mocked(getSpotGuardRepository).mockReturnValue(mockRepo);
    vi.mocked(getAccountRepository).mockReturnValue({ getAccount: vi.fn().mockResolvedValue(ACCOUNT_ROW) } as any);
    vi.mocked(ecsClientFor).mockResolvedValue({} as any);
    vi.mocked(describeService).mockResolvedValue(LIVE as any);
    vi.mocked(clusterCapacityProviders).mockResolvedValue(['FARGATE', 'FARGATE_SPOT']);
    vi.mocked(updateCapacityProvider).mockResolvedValue(undefined as any);
});

describe('read delegations', () => {
    it.each([
        ['getFacets', () => SpotGuardService.getFacets('t1'), 'getFacets', ['t1']],
        ['getSummary', () => SpotGuardService.getSummary('t1'), 'getSummary', ['t1']],
    ] as const)('%s delegates straight to the repository', async (_name, call, repoMethod, args) => {
        mockRepo[repoMethod].mockResolvedValue({ ok: true });
        const result = await call();
        expect(result).toEqual({ ok: true });
        expect(mockRepo[repoMethod]).toHaveBeenCalledWith(...args);
    });

    it('listServices/listEvents/listEligibleServices/getHoursReport delegate with the filters object', async () => {
        mockRepo.listServices.mockResolvedValue({ services: [], total: 0 });
        await SpotGuardService.listServices({ tenantId: 't1' } as any);
        expect(mockRepo.listServices).toHaveBeenCalledWith({ tenantId: 't1' });

        mockRepo.listEvents.mockResolvedValue({ events: [], total: 0 });
        await SpotGuardService.listEvents({ tenantId: 't1' } as any);
        expect(mockRepo.listEvents).toHaveBeenCalledWith({ tenantId: 't1' });

        mockRepo.listEligibleServices.mockResolvedValue({ services: [], total: 0 });
        await SpotGuardService.listEligibleServices({ tenantId: 't1' } as any);
        expect(mockRepo.listEligibleServices).toHaveBeenCalledWith({ tenantId: 't1' });

        const range = { from: new Date(), to: new Date() };
        mockRepo.getHoursReport.mockResolvedValue({});
        await SpotGuardService.getHoursReport('t1', range);
        expect(mockRepo.getHoursReport).toHaveBeenCalledWith('t1', range);
    });
});

describe('getServiceDetail', () => {
    it('throws NOT_FOUND when the service does not exist', async () => {
        mockRepo.getService.mockResolvedValue(null);
        await expect(SpotGuardService.getServiceDetail('sg-x', 't1')).rejects.toThrow(SpotGuardErrors.NOT_FOUND);
    });

    it('returns the service with its recent event timeline', async () => {
        mockRepo.getService.mockResolvedValue(SERVICE_ROW);
        mockRepo.listEvents.mockResolvedValue({ events: [{ id: 'e1' }], total: 1 });
        const result = await SpotGuardService.getServiceDetail('sg-1', 't1');
        expect(result.service).toBe(SERVICE_ROW);
        expect(result.events).toEqual([{ id: 'e1' }]);
        expect(mockRepo.listEvents).toHaveBeenCalledWith({ tenantId: 't1', spotServiceId: 'sg-1', limit: 50 });
    });

    it('degrades to an empty timeline rather than 500ing when the event lookup fails', async () => {
        mockRepo.getService.mockResolvedValue(SERVICE_ROW);
        mockRepo.listEvents.mockRejectedValue(new Error('down'));
        const result = await SpotGuardService.getServiceDetail('sg-1', 't1');
        expect(result.events).toEqual([]);
    });
});

// NOTE: enableSpot's belt-and-braces `if (!isSpotFirstState(nextStrategy)) throw ...` is
// provably unreachable: buildSpotFirstStrategy (which both code paths funnel through) computes
// `Math.max(opts.spotWeight ?? RESTORE_SPOT_MIN_WEIGHT, 1)`, flooring the Spot weight at 1 no
// matter what a caller passes — including 0 — so isSpotFirstState is always true afterward.
// Left untested, same convention as other documented-unreachable branches this session.
describe('enableSpot', () => {
    const INPUT = { confirmServiceName: 'svc-a' };

    it('throws NOT_FOUND for an unknown registry id', async () => {
        mockRepo.getService.mockResolvedValue(null);
        await expect(
            SpotGuardService.enableSpot('t1', { kind: 'registry', id: 'sg-x' }, 'u1', INPUT),
        ).rejects.toThrow(SpotGuardErrors.NOT_FOUND);
    });

    it('resolves a discovered target with no registry row into a fresh identity', async () => {
        mockRepo.findServiceByTarget.mockResolvedValue(null);
        mockRepo.upsertService.mockResolvedValue({ ...SERVICE_ROW, id: 'sg-new' });

        const result = await SpotGuardService.enableSpot(
            't1',
            { kind: 'discovered', accountId: 'acc-1', region: 'ap-south-1', clusterName: 'cluster-a', serviceName: 'svc-a' },
            'u1',
            INPUT,
        );

        expect(result.id).toBe('sg-new');
        expect(mockRepo.upsertService).toHaveBeenCalledWith('t1', expect.objectContaining({ managementState: 'managed' }));
    });

    it('throws CONFIRMATION_MISMATCH when the confirm text does not match the service name', async () => {
        mockRepo.getService.mockResolvedValue(SERVICE_ROW);
        await expect(
            SpotGuardService.enableSpot('t1', { kind: 'registry', id: 'sg-1' }, 'u1', { confirmServiceName: 'wrong-name' }),
        ).rejects.toThrow(SpotGuardErrors.CONFIRMATION_MISMATCH);
        expect(getAccountRepository).not.toHaveBeenCalled();
    });

    it('throws ACCOUNT_NOT_FOUND when the account has no roleArn on file', async () => {
        mockRepo.getService.mockResolvedValue(SERVICE_ROW);
        vi.mocked(getAccountRepository).mockReturnValue({ getAccount: vi.fn().mockResolvedValue(null) } as any);
        await expect(
            SpotGuardService.enableSpot('t1', { kind: 'registry', id: 'sg-1' }, 'u1', INPUT),
        ).rejects.toThrow(SpotGuardErrors.ACCOUNT_NOT_FOUND);
    });

    it('throws SPOT_AUTOMATION_DISABLED before ever calling AWS, when the account has not opted in', async () => {
        mockRepo.getService.mockResolvedValue(SERVICE_ROW);
        vi.mocked(getAccountRepository).mockReturnValue({
            getAccount: vi.fn().mockResolvedValue({ ...ACCOUNT_ROW, spotAutomationEnabled: false }),
        } as any);

        await expect(
            SpotGuardService.enableSpot('t1', { kind: 'registry', id: 'sg-1' }, 'u1', INPUT),
        ).rejects.toThrow(SpotGuardErrors.SPOT_AUTOMATION_DISABLED);
        expect(ecsClientFor).not.toHaveBeenCalled();
    });

    it('throws SERVICE_NOT_IN_AWS when the live describe finds nothing', async () => {
        mockRepo.getService.mockResolvedValue(SERVICE_ROW);
        vi.mocked(describeService).mockResolvedValue(null as any);
        await expect(
            SpotGuardService.enableSpot('t1', { kind: 'registry', id: 'sg-1' }, 'u1', INPUT),
        ).rejects.toThrow(SpotGuardErrors.SERVICE_NOT_IN_AWS);
    });

    it('throws DEPLOYMENT_IN_PROGRESS rather than stacking a capacity change on a live rollout', async () => {
        mockRepo.getService.mockResolvedValue(SERVICE_ROW);
        vi.mocked(describeService).mockResolvedValue({ ...LIVE, deploymentInProgress: true } as any);
        await expect(
            SpotGuardService.enableSpot('t1', { kind: 'registry', id: 'sg-1' }, 'u1', INPUT),
        ).rejects.toThrow(SpotGuardErrors.DEPLOYMENT_IN_PROGRESS);
    });

    it('reweights an existing Spot provider without a capacity-providers lookup', async () => {
        mockRepo.getService.mockResolvedValue(SERVICE_ROW);
        vi.mocked(describeService).mockResolvedValue({ ...LIVE, strategy: SPOT_FIRST } as any);
        mockRepo.upsertService.mockResolvedValue(SERVICE_ROW);

        await SpotGuardService.enableSpot('t1', { kind: 'registry', id: 'sg-1' }, 'u1', INPUT);

        expect(clusterCapacityProviders).not.toHaveBeenCalled();
        expect(updateCapacityProvider).toHaveBeenCalled();
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'spot_guard.spot.enabled', severity: 'high' }),
        );
    });

    it('adds the cluster spot provider when the strategy has none and the cluster offers one', async () => {
        mockRepo.getService.mockResolvedValue(SERVICE_ROW);
        mockRepo.upsertService.mockResolvedValue(SERVICE_ROW);
        vi.mocked(clusterCapacityProviders).mockResolvedValue(['FARGATE', 'my-spot-asg']);

        await SpotGuardService.enableSpot('t1', { kind: 'registry', id: 'sg-1' }, 'u1', INPUT);

        expect(updateCapacityProvider).toHaveBeenCalled();
    });

    it('throws a 409-shaped NO_SPOT_CAPACITY_PROVIDER error listing the cluster providers when none is Spot', async () => {
        mockRepo.getService.mockResolvedValue(SERVICE_ROW);
        vi.mocked(clusterCapacityProviders).mockResolvedValue(['FARGATE']);

        await expect(
            SpotGuardService.enableSpot('t1', { kind: 'registry', id: 'sg-1' }, 'u1', INPUT),
        ).rejects.toThrow(/NO_SPOT_CAPACITY_PROVIDER: cluster cluster-a offers \[FARGATE\]/);
    });

    it('lists "none" when the cluster reports zero capacity providers at all', async () => {
        mockRepo.getService.mockResolvedValue(SERVICE_ROW);
        vi.mocked(clusterCapacityProviders).mockResolvedValue([]);
        await expect(
            SpotGuardService.enableSpot('t1', { kind: 'registry', id: 'sg-1' }, 'u1', INPUT),
        ).rejects.toThrow(/offers \[none\]/);
    });

    it('defaults clusterArn/serviceArn to null when the live describe omits them', async () => {
        mockRepo.getService.mockResolvedValue(SERVICE_ROW);
        mockRepo.upsertService.mockResolvedValue(SERVICE_ROW);
        vi.mocked(describeService).mockResolvedValue({ ...LIVE, strategy: SPOT_FIRST, raw: {} } as any);

        await SpotGuardService.enableSpot('t1', { kind: 'registry', id: 'sg-1' }, 'u1', INPUT);

        const saveArg = mockRepo.upsertService.mock.calls[0][1];
        expect(saveArg.clusterArn).toBeNull();
        expect(saveArg.serviceArn).toBeNull();
    });

    it('treats a missing spotAutomationEnabled flag on the account as disabled (fail closed)', async () => {
        mockRepo.getService.mockResolvedValue(SERVICE_ROW);
        vi.mocked(getAccountRepository).mockReturnValue({
            getAccount: vi.fn().mockResolvedValue({ ...ACCOUNT_ROW, spotAutomationEnabled: undefined }),
        } as any);

        await expect(
            SpotGuardService.enableSpot('t1', { kind: 'registry', id: 'sg-1' }, 'u1', INPUT),
        ).rejects.toThrow(SpotGuardErrors.SPOT_AUTOMATION_DISABLED);
    });

    it('records the event and audit log with before/after strategy on success', async () => {
        mockRepo.getService.mockResolvedValue(SERVICE_ROW);
        mockRepo.upsertService.mockResolvedValue({ ...SERVICE_ROW, id: 'sg-1' });
        vi.mocked(describeService).mockResolvedValue({ ...LIVE, strategy: SPOT_FIRST } as any);

        await SpotGuardService.enableSpot('t1', { kind: 'registry', id: 'sg-1' }, 'u1', INPUT);

        expect(mockRepo.recordEvent).toHaveBeenCalledWith('t1', expect.objectContaining({
            eventType: 'spot_enabled', spotServiceId: 'sg-1',
        }));
    });
});

describe('disableSpot', () => {
    const INPUT = { confirmServiceName: 'svc-a' };

    it('throws NOT_FOUND for an unknown service', async () => {
        mockRepo.getService.mockResolvedValue(null);
        await expect(SpotGuardService.disableSpot('t1', 'sg-x', 'u1', INPUT)).rejects.toThrow(SpotGuardErrors.NOT_FOUND);
    });

    it('throws CONFIRMATION_MISMATCH on a wrong confirm string', async () => {
        mockRepo.getService.mockResolvedValue(SERVICE_ROW);
        await expect(
            SpotGuardService.disableSpot('t1', 'sg-1', 'u1', { confirmServiceName: 'nope' }),
        ).rejects.toThrow(SpotGuardErrors.CONFIRMATION_MISMATCH);
    });

    it('throws SERVICE_NOT_IN_AWS when live describe returns nothing', async () => {
        mockRepo.getService.mockResolvedValue(SERVICE_ROW);
        vi.mocked(describeService).mockResolvedValue(null as any);
        await expect(SpotGuardService.disableSpot('t1', 'sg-1', 'u1', INPUT)).rejects.toThrow(SpotGuardErrors.SERVICE_NOT_IN_AWS);
    });

    it('throws DEPLOYMENT_IN_PROGRESS during a live rollout', async () => {
        mockRepo.getService.mockResolvedValue(SERVICE_ROW);
        vi.mocked(describeService).mockResolvedValue({ ...LIVE, deploymentInProgress: true } as any);
        await expect(SpotGuardService.disableSpot('t1', 'sg-1', 'u1', INPUT)).rejects.toThrow(SpotGuardErrors.DEPLOYMENT_IN_PROGRESS);
    });

    it('applies the fallback strategy, marks opted_out, and audit-logs on success', async () => {
        mockRepo.getService.mockResolvedValue(SERVICE_ROW);
        mockRepo.upsertService.mockResolvedValue({ ...SERVICE_ROW, managementState: 'opted_out' });
        vi.mocked(describeService).mockResolvedValue({ ...LIVE, strategy: SPOT_FIRST } as any);

        const result = await SpotGuardService.disableSpot('t1', 'sg-1', 'u1', INPUT);

        expect(result.managementState).toBe('opted_out');
        expect(updateCapacityProvider).toHaveBeenCalled();
        expect(mockRepo.upsertService).toHaveBeenCalledWith('t1', expect.objectContaining({
            managementState: 'opted_out', disabledBy: 'u1', resetRestoreState: true,
        }));
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'spot_guard.spot.disabled', severity: 'high' }),
        );
    });
});

describe('setManagementState', () => {
    it('updates the state without touching AWS, records the event, and audit-logs at medium severity', async () => {
        mockRepo.setManagementState.mockResolvedValue({ ...SERVICE_ROW, managementState: 'unmanaged' });

        const result = await SpotGuardService.setManagementState('t1', 'sg-1', 'unmanaged', 'u1');

        expect(result.managementState).toBe('unmanaged');
        expect(updateCapacityProvider).not.toHaveBeenCalled();
        expect(mockRepo.recordEvent).toHaveBeenCalledWith('t1', expect.objectContaining({ eventType: 'unmanaged' }));
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'spot_guard.management.changed', severity: 'medium' }),
        );
    });
});

describe('triggerRestore', () => {
    it('queues a restore job scoped to the tenant and audit-logs the trigger', async () => {
        const mockSend = vi.fn().mockResolvedValue('job-123');
        vi.mocked(getBoss).mockResolvedValue({ send: mockSend } as any);

        const result = await SpotGuardService.triggerRestore('t1', 'u1');

        expect(result).toEqual({ jobId: 'job-123' });
        expect(mockSend).toHaveBeenCalledWith(
            'spot-guard-restore-scan',
            { tenantId: 't1', trigger: 'manual', serviceIds: undefined, force: true },
            { singletonKey: 'tenant:t1', retryLimit: 0 },
        );
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ eventType: 'spot_guard.restore.triggered', status: 'success' }),
        );
    });

    it('reports a null jobId (already queued/running) with a distinct audit message, not an error', async () => {
        vi.mocked(getBoss).mockResolvedValue({ send: vi.fn().mockResolvedValue(null) } as any);

        const result = await SpotGuardService.triggerRestore('t1', 'u1');

        expect(result).toEqual({ jobId: null });
        expect(AuditService.logUserAction).toHaveBeenCalledWith(
            expect.objectContaining({ details: expect.stringContaining('already queued or running') }),
        );
    });

    it('scopes the resourceId to the given serviceIds and mentions the count when provided', async () => {
        vi.mocked(getBoss).mockResolvedValue({ send: vi.fn().mockResolvedValue('job-1') } as any);

        await SpotGuardService.triggerRestore('t1', 'u1', ['sg-1', 'sg-2']);

        expect(AuditService.logUserAction).toHaveBeenCalledWith(expect.objectContaining({
            resourceId: 'sg-1,sg-2',
            details: expect.stringContaining('for 2 service(s)'),
        }));
    });
});
