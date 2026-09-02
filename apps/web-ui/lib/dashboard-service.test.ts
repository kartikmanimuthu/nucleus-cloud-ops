import { describe, it, expect, vi } from 'vitest';

const mockRepo = {
    getKpiStats: vi.fn().mockResolvedValue({ kpi: true }),
    getCostMetrics: vi.fn().mockResolvedValue({ cost: true }),
    getOperationsMetrics: vi.fn().mockResolvedValue({ ops: true }),
    getAgentMetrics: vi.fn().mockResolvedValue({ agent: true }),
    getAuditMetrics: vi.fn().mockResolvedValue({ audit: true }),
    getInventoryMetrics: vi.fn().mockResolvedValue({ inventory: true }),
    getKnowledgeBaseMetrics: vi.fn().mockResolvedValue({ kb: true }),
    getHeroKpis: vi.fn().mockResolvedValue({ hero: true }),
    getActionCenter: vi.fn().mockResolvedValue({ actions: true }),
    getCoverage: vi.fn().mockResolvedValue({ coverage: true }),
    getCostAutomation: vi.fn().mockResolvedValue({ costAutomation: true }),
    getAgentActivity: vi.fn().mockResolvedValue({ activity: true }),
    getInventorySnapshot: vi.fn().mockResolvedValue({ snapshot: true }),
    getAuditSnapshot: vi.fn().mockResolvedValue({ auditSnapshot: true }),
};

vi.mock('@/lib/db/repository-factory', () => ({
    getDashboardRepository: vi.fn(() => mockRepo),
}));

import { DashboardService } from '@/lib/dashboard-service';

describe('DashboardService', () => {
    const tenantId = 'tenant-1';
    const range = '7d' as any;

    it('getKpiStats delegates to the repository with tenantId and range', async () => {
        expect(await DashboardService.getKpiStats(tenantId, range)).toEqual({ kpi: true });
        expect(mockRepo.getKpiStats).toHaveBeenCalledWith(tenantId, range);
    });

    it('getCostMetrics delegates to the repository', async () => {
        expect(await DashboardService.getCostMetrics(tenantId, range)).toEqual({ cost: true });
        expect(mockRepo.getCostMetrics).toHaveBeenCalledWith(tenantId, range);
    });

    it('getOperationsMetrics delegates to the repository', async () => {
        expect(await DashboardService.getOperationsMetrics(tenantId, range)).toEqual({ ops: true });
        expect(mockRepo.getOperationsMetrics).toHaveBeenCalledWith(tenantId, range);
    });

    it('getAgentMetrics delegates to the repository', async () => {
        expect(await DashboardService.getAgentMetrics(tenantId, range)).toEqual({ agent: true });
        expect(mockRepo.getAgentMetrics).toHaveBeenCalledWith(tenantId, range);
    });

    it('getAuditMetrics delegates to the repository', async () => {
        expect(await DashboardService.getAuditMetrics(tenantId, range)).toEqual({ audit: true });
        expect(mockRepo.getAuditMetrics).toHaveBeenCalledWith(tenantId, range);
    });

    it('getInventoryMetrics delegates to the repository', async () => {
        expect(await DashboardService.getInventoryMetrics(tenantId, range)).toEqual({ inventory: true });
        expect(mockRepo.getInventoryMetrics).toHaveBeenCalledWith(tenantId, range);
    });

    it('getKnowledgeBaseMetrics delegates to the repository with only tenantId', async () => {
        expect(await DashboardService.getKnowledgeBaseMetrics(tenantId)).toEqual({ kb: true });
        expect(mockRepo.getKnowledgeBaseMetrics).toHaveBeenCalledWith(tenantId);
    });

    it('getHeroKpis delegates to the repository', async () => {
        expect(await DashboardService.getHeroKpis(tenantId, range)).toEqual({ hero: true });
        expect(mockRepo.getHeroKpis).toHaveBeenCalledWith(tenantId, range);
    });

    it('getActionCenter delegates to the repository', async () => {
        expect(await DashboardService.getActionCenter(tenantId, range)).toEqual({ actions: true });
        expect(mockRepo.getActionCenter).toHaveBeenCalledWith(tenantId, range);
    });

    it('getCoverage delegates to the repository with only tenantId', async () => {
        expect(await DashboardService.getCoverage(tenantId)).toEqual({ coverage: true });
        expect(mockRepo.getCoverage).toHaveBeenCalledWith(tenantId);
    });

    it('getCostAutomation delegates to the repository', async () => {
        expect(await DashboardService.getCostAutomation(tenantId, range)).toEqual({ costAutomation: true });
        expect(mockRepo.getCostAutomation).toHaveBeenCalledWith(tenantId, range);
    });

    it('getAgentActivity delegates to the repository', async () => {
        expect(await DashboardService.getAgentActivity(tenantId, range)).toEqual({ activity: true });
        expect(mockRepo.getAgentActivity).toHaveBeenCalledWith(tenantId, range);
    });

    it('getInventorySnapshot delegates to the repository with only tenantId', async () => {
        expect(await DashboardService.getInventorySnapshot(tenantId)).toEqual({ snapshot: true });
        expect(mockRepo.getInventorySnapshot).toHaveBeenCalledWith(tenantId);
    });

    it('getAuditSnapshot delegates to the repository', async () => {
        expect(await DashboardService.getAuditSnapshot(tenantId, range)).toEqual({ auditSnapshot: true });
        expect(mockRepo.getAuditSnapshot).toHaveBeenCalledWith(tenantId, range);
    });
});
