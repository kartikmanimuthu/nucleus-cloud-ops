/**
 * DashboardService
 *
 * Thin orchestrator over IDashboardRepository. All raw data access has moved to
 * apps/web-ui/lib/db/repositories/dashboard/postgres.ts so the service layer
 * stays focused on formatting, permission-aware filtering, and cross-domain
 * coordination.
 */
import { getDashboardRepository } from '@/lib/db/repository-factory';
import type {
    TimeRange,
    KpiResponse,
    CostResponse,
    OperationsResponse,
    AgentResponse,
    AuditDashboardResponse,
    InventoryResponse,
    KnowledgeBaseResponse,
    HeroKpisResponse,
    ActionCenterResponse,
    CoverageResponse,
    CostAutomationResponse,
    AgentActivityResponse,
    InventorySnapshotResponse,
    AuditSnapshotResponse,
} from '@/lib/dashboard-types';

export class DashboardService {
    // Legacy endpoints — kept until new dashboard components replace them.
    static async getKpiStats(tenantId: string, range: TimeRange): Promise<KpiResponse> {
        return getDashboardRepository().getKpiStats(tenantId, range);
    }

    static async getCostMetrics(tenantId: string, range: TimeRange): Promise<CostResponse> {
        return getDashboardRepository().getCostMetrics(tenantId, range);
    }

    static async getOperationsMetrics(tenantId: string, range: TimeRange): Promise<OperationsResponse> {
        return getDashboardRepository().getOperationsMetrics(tenantId, range);
    }

    static async getAgentMetrics(tenantId: string, range: TimeRange): Promise<AgentResponse> {
        return getDashboardRepository().getAgentMetrics(tenantId, range);
    }

    static async getAuditMetrics(tenantId: string, range: TimeRange): Promise<AuditDashboardResponse> {
        return getDashboardRepository().getAuditMetrics(tenantId, range);
    }

    static async getInventoryMetrics(tenantId: string, range: TimeRange): Promise<InventoryResponse> {
        return getDashboardRepository().getInventoryMetrics(tenantId, range);
    }

    static async getKnowledgeBaseMetrics(tenantId: string): Promise<KnowledgeBaseResponse> {
        return getDashboardRepository().getKnowledgeBaseMetrics(tenantId);
    }

    // New zone-based dashboard endpoints.
    static async getHeroKpis(tenantId: string, range: TimeRange): Promise<HeroKpisResponse> {
        return getDashboardRepository().getHeroKpis(tenantId, range);
    }

    static async getActionCenter(tenantId: string, range: TimeRange): Promise<ActionCenterResponse> {
        return getDashboardRepository().getActionCenter(tenantId, range);
    }

    static async getCoverage(tenantId: string): Promise<CoverageResponse> {
        return getDashboardRepository().getCoverage(tenantId);
    }

    static async getCostAutomation(tenantId: string, range: TimeRange): Promise<CostAutomationResponse> {
        return getDashboardRepository().getCostAutomation(tenantId, range);
    }

    static async getAgentActivity(tenantId: string, range: TimeRange): Promise<AgentActivityResponse> {
        return getDashboardRepository().getAgentActivity(tenantId, range);
    }

    static async getInventorySnapshot(tenantId: string): Promise<InventorySnapshotResponse> {
        return getDashboardRepository().getInventorySnapshot(tenantId);
    }

    static async getAuditSnapshot(tenantId: string, range: TimeRange): Promise<AuditSnapshotResponse> {
        return getDashboardRepository().getAuditSnapshot(tenantId, range);
    }
}
