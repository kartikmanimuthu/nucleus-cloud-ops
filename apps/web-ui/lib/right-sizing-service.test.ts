import { describe, it, expect, vi, beforeEach } from 'vitest';

const repoMock = {
    listRecommendations: vi.fn(),
    getRecommendation: vi.fn(),
    getSummary: vi.fn(),
    listRuns: vi.fn(),
    updateStatus: vi.fn(),
    getActiveRun: vi.fn(),
    createRun: vi.fn(),
};
const inventoryRepoMock = { getResource: vi.fn() };
const accountRepoMock = { getAccount: vi.fn() };
const bossSend = vi.fn();
vi.mock('@/lib/db/repository-factory', () => ({
    getRightSizingRepository: () => repoMock,
    getInventoryRepository: () => inventoryRepoMock,
    getAccountRepository: () => accountRepoMock,
}));
vi.mock('@/lib/audit-service', () => ({
    AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('@/lib/boss-client', () => ({
    getBoss: vi.fn().mockResolvedValue({ send: (...args: unknown[]) => bossSend(...args) }),
}));

import { RightSizingService } from './right-sizing-service';

describe('RightSizingService thin delegators', () => {
    it('listRecommendations delegates to the repository', async () => {
        repoMock.listRecommendations.mockResolvedValue({ items: [], total: 0 });
        const filters = { tenantId: 'tenant-a' } as any;
        const result = await RightSizingService.listRecommendations(filters);
        expect(repoMock.listRecommendations).toHaveBeenCalledWith(filters);
        expect(result).toEqual({ items: [], total: 0 });
    });

    it('getRecommendation delegates to the repository', async () => {
        repoMock.getRecommendation.mockResolvedValue({ id: 'rec-1' });
        const result = await RightSizingService.getRecommendation('rec-1', 'tenant-a');
        expect(repoMock.getRecommendation).toHaveBeenCalledWith('rec-1', 'tenant-a');
        expect(result).toEqual({ id: 'rec-1' });
    });

    it('getSummary delegates to the repository', async () => {
        repoMock.getSummary.mockResolvedValue({ totalRecommendations: 3 });
        const result = await RightSizingService.getSummary('tenant-a');
        expect(repoMock.getSummary).toHaveBeenCalledWith('tenant-a');
        expect(result).toEqual({ totalRecommendations: 3 });
    });

    it('listRuns delegates to the repository with page/limit', async () => {
        repoMock.listRuns.mockResolvedValue({ runs: [], total: 0 });
        const result = await RightSizingService.listRuns('tenant-a', 2, 25);
        expect(repoMock.listRuns).toHaveBeenCalledWith('tenant-a', 2, 25);
        expect(result).toEqual({ runs: [], total: 0 });
    });
});

describe('RightSizingService.updateStatus', () => {
    beforeEach(() => {
        repoMock.getRecommendation.mockReset();
        repoMock.updateStatus.mockReset();
    });

    it('rejects an unrecognized status', async () => {
        await expect(
            RightSizingService.updateStatus('rec-1', 'tenant-a', 'bogus' as never, 'user-1')
        ).rejects.toThrow('Invalid status: bogus');
        expect(repoMock.getRecommendation).not.toHaveBeenCalled();
    });

    it('throws NOT_FOUND when the recommendation is not in the caller tenant (no cross-tenant write)', async () => {
        repoMock.getRecommendation.mockResolvedValue(null); // tenant-scoped lookup misses
        await expect(
            RightSizingService.updateStatus('rec-x', 'tenant-a', 'approved', 'user-1')
        ).rejects.toThrow('NOT_FOUND');
        expect(repoMock.updateStatus).not.toHaveBeenCalled();
    });

    it('rejects the reserved "applied" status (no automated resize in v1)', async () => {
        await expect(
            RightSizingService.updateStatus('rec-1', 'tenant-a', 'applied' as never, 'user-1')
        ).rejects.toThrow(/not supported/i);
        expect(repoMock.getRecommendation).not.toHaveBeenCalled();
    });

    it('updates status when the recommendation belongs to the tenant', async () => {
        repoMock.getRecommendation.mockResolvedValue({
            id: 'rec-1',
            resourceId: 'i-1',
            resourceType: 'ec2_instances',
            finding: 'over_provisioned',
            status: 'open',
            estimatedMonthlySavings: 100,
        });
        repoMock.updateStatus.mockResolvedValue({ id: 'rec-1', status: 'approved' });
        const res = await RightSizingService.updateStatus('rec-1', 'tenant-a', 'approved', 'user-1');
        expect(res.status).toBe('approved');
        expect(repoMock.updateStatus).toHaveBeenCalledWith('rec-1', 'tenant-a', 'approved', 'user-1', undefined);
    });
});

describe('RightSizingService.triggerScan', () => {
    beforeEach(() => {
        repoMock.getActiveRun.mockReset();
        repoMock.createRun.mockReset();
        bossSend.mockReset();
    });

    it('reports alreadyRunning (no duplicate) when the singleton job is already queued/active', async () => {
        bossSend.mockResolvedValue(null); // pg-boss singletonKey dedup → null
        repoMock.getActiveRun.mockResolvedValue({ id: 'run-active', status: 'running' });
        const { run, alreadyRunning } = await RightSizingService.triggerScan('tenant-a', 'user-1');
        expect(alreadyRunning).toBe(true);
        expect(run?.id).toBe('run-active');
        // The API never pre-creates a run — the worker owns run creation (no race / no orphan).
        expect(repoMock.createRun).not.toHaveBeenCalled();
    });

    it('enqueues a new scan when none is active (worker creates the run)', async () => {
        bossSend.mockResolvedValue('job-1');
        repoMock.getActiveRun.mockResolvedValue(null);
        const { alreadyRunning } = await RightSizingService.triggerScan('tenant-a', 'user-1');
        expect(alreadyRunning).toBe(false);
        expect(bossSend).toHaveBeenCalledWith(
            'right-sizing-scan',
            expect.objectContaining({ tenantId: 'tenant-a', trigger: 'manual' }),
            expect.objectContaining({ singletonKey: 'tenant:tenant-a' })
        );
        expect(repoMock.createRun).not.toHaveBeenCalled();
    });
});

describe('RightSizingService.getRecommendationDetail', () => {
    beforeEach(() => {
        repoMock.getRecommendation.mockReset();
        inventoryRepoMock.getResource.mockReset();
        accountRepoMock.getAccount.mockReset();
    });

    it('returns null when the recommendation is not found (no cross-tenant leak)', async () => {
        repoMock.getRecommendation.mockResolvedValue(null);
        const result = await RightSizingService.getRecommendationDetail('rec-x', 'tenant-a');
        expect(result).toBeNull();
        expect(inventoryRepoMock.getResource).not.toHaveBeenCalled();
        expect(accountRepoMock.getAccount).not.toHaveBeenCalled();
    });

    it('composes recommendation + resource + account when all three exist', async () => {
        repoMock.getRecommendation.mockResolvedValue({
            id: 'rec-1',
            accountId: '123456789012',
            resourceType: 'ec2_instances',
            resourceId: 'i-1',
        });
        inventoryRepoMock.getResource.mockResolvedValue({ id: 'inv-1', metadata: { vpcId: 'vpc-1' } });
        accountRepoMock.getAccount.mockResolvedValue({ id: 'acc-1', name: 'Prod' });

        const result = await RightSizingService.getRecommendationDetail('rec-1', 'tenant-a');

        expect(result?.recommendation.id).toBe('rec-1');
        expect(result?.resource?.metadata).toEqual({ vpcId: 'vpc-1' });
        expect(result?.account?.name).toBe('Prod');
        expect(inventoryRepoMock.getResource).toHaveBeenCalledWith('tenant-a', '123456789012', 'ec2_instances', 'i-1');
        expect(accountRepoMock.getAccount).toHaveBeenCalledWith('123456789012', 'tenant-a');
    });

    it('degrades gracefully when the inventory/account lookups fail or return null', async () => {
        repoMock.getRecommendation.mockResolvedValue({
            id: 'rec-1',
            accountId: '123456789012',
            resourceType: 'ec2_instances',
            resourceId: 'i-1',
        });
        inventoryRepoMock.getResource.mockRejectedValue(new Error('boom'));
        accountRepoMock.getAccount.mockResolvedValue(null);

        const result = await RightSizingService.getRecommendationDetail('rec-1', 'tenant-a');

        expect(result?.recommendation.id).toBe('rec-1');
        expect(result?.resource).toBeNull();
        expect(result?.account).toBeNull();
    });

    it('degrades the account field to null when the account lookup itself rejects', async () => {
        repoMock.getRecommendation.mockResolvedValue({
            id: 'rec-1', accountId: '123456789012', resourceType: 'ec2_instances', resourceId: 'i-1',
        });
        inventoryRepoMock.getResource.mockResolvedValue({ id: 'inv-1' });
        accountRepoMock.getAccount.mockRejectedValue(new Error('account service down'));

        const result = await RightSizingService.getRecommendationDetail('rec-1', 'tenant-a');

        expect(result?.account).toBeNull();
    });
});
