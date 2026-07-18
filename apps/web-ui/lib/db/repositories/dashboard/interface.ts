/**
 * IDashboardRepository
 *
 * Contract for dashboard metric persistence. Implementations are responsible for
 * all raw data access (Prisma queries, aggregations, etc.) while the service
 * layer owns formatting, business-rule transformations, and response assembly.
 */
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

export interface IDashboardRepository {
    // -------------------------------------------------------------------------
    // Legacy zone methods (deprecated — keep until old dashboard components are
    // removed and old API routes are deleted).
    // -------------------------------------------------------------------------
    getKpiStats(tenantId: string, range: TimeRange): Promise<KpiResponse>;
    getCostMetrics(tenantId: string, range: TimeRange): Promise<CostResponse>;
    getOperationsMetrics(tenantId: string, range: TimeRange): Promise<OperationsResponse>;
    getAgentMetrics(tenantId: string, range: TimeRange): Promise<AgentResponse>;
    getAuditMetrics(tenantId: string, range: TimeRange): Promise<AuditDashboardResponse>;
    getInventoryMetrics(tenantId: string, range: TimeRange): Promise<InventoryResponse>;
    getKnowledgeBaseMetrics(tenantId: string): Promise<KnowledgeBaseResponse>;

    // -------------------------------------------------------------------------
    // New zone-based methods (used by the refactored dashboard UI).
    // -------------------------------------------------------------------------
    getHeroKpis(tenantId: string, range: TimeRange): Promise<HeroKpisResponse>;
    getActionCenter(tenantId: string, range: TimeRange): Promise<ActionCenterResponse>;
    getCoverage(tenantId: string): Promise<CoverageResponse>;
    getCostAutomation(tenantId: string, range: TimeRange): Promise<CostAutomationResponse>;
    getAgentActivity(tenantId: string, range: TimeRange): Promise<AgentActivityResponse>;
    getInventorySnapshot(tenantId: string): Promise<InventorySnapshotResponse>;
    getAuditSnapshot(tenantId: string, range: TimeRange): Promise<AuditSnapshotResponse>;
}
