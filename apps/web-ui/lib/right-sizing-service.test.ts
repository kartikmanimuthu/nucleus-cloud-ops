import { describe, it, expect, vi, beforeEach } from 'vitest';

const repoMock = {
    getRecommendation: vi.fn(),
    updateStatus: vi.fn(),
    getActiveRun: vi.fn(),
    createRun: vi.fn(),
};
const bossSend = vi.fn();
vi.mock('@/lib/db/repository-factory', () => ({
    getRightSizingRepository: () => repoMock,
}));
vi.mock('@/lib/audit-service', () => ({
    AuditService: { logUserAction: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('@/lib/boss-client', () => ({
    getBoss: vi.fn().mockResolvedValue({ send: (...args: unknown[]) => bossSend(...args) }),
}));

import { RightSizingService } from './right-sizing-service';

describe('RightSizingService.updateStatus', () => {
    beforeEach(() => {
        repoMock.getRecommendation.mockReset();
        repoMock.updateStatus.mockReset();
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
