/**
 * IRightSizingRepository
 *
 * Contract for right-sizing recommendation + run persistence.
 * Implemented by RightSizingPostgresRepository.
 *
 * Multi-tenant safety: every query is scoped by tenantId — no cross-tenant access.
 */

import type { PrismaRowFilter } from '@/lib/db/pg-config';

export type Finding = 'over_provisioned' | 'under_provisioned' | 'idle' | 'optimized';
export type RiskLevel = 'low' | 'medium' | 'high';
export type RecommendationStatus = 'open' | 'approved' | 'dismissed' | 'snoozed' | 'applied';
export type RunStatus = 'queued' | 'running' | 'completed' | 'failed';
export type RunTrigger = 'schedule' | 'manual';

export interface RightSizingRecommendation {
    id: string;
    tenantId: string;
    accountId: string;
    region: string;
    resourceType: string;
    resourceId: string;
    name?: string;
    finding: Finding;
    currentConfig: Record<string, unknown>;
    recommendedConfig?: Record<string, unknown> | null;
    metricsSummary: Record<string, unknown>;
    lookbackDays: number;
    currency: string;
    currentMonthlyCost?: number | null;
    recommendedMonthlyCost?: number | null;
    estimatedMonthlySavings: number;
    confidence: number;
    riskLevel: RiskLevel;
    rationale: string;
    source: string;
    status: RecommendationStatus;
    snoozeUntil?: string | null;
    reviewedBy?: string | null;
    reviewedAt?: string | null;
    generatedByRunId?: string | null;
    generatedAt: string;
    updatedAt: string;
}

/** Shape used to upsert a freshly computed recommendation (engine output). */
export type RecommendationUpsert = Omit<
    RightSizingRecommendation,
    'id' | 'status' | 'snoozeUntil' | 'reviewedBy' | 'reviewedAt' | 'generatedAt' | 'updatedAt'
> & {
    status?: RecommendationStatus;
};

export interface RecommendationFilters {
    tenantId: string;
    accountId?: string;
    accountIds?: string[];
    region?: string;
    resourceType?: string;
    finding?: Finding;
    status?: RecommendationStatus;
    searchTerm?: string;
    page?: number;
    limit?: number;
    sort?: 'savings' | 'confidence' | 'resource';
    /**
     * Gate 3 (RBAC row filtering): a Prisma `where` fragment restricting the
     * result to the rows the caller may read. Built by
     * getReadRowFilter() in lib/rbac/row-filter.ts and INTERSECTED with the
     * query below via andWhere() — never merged over it.
     */
    rowFilter?: PrismaRowFilter | null;
}

export interface RecommendationPage {
    recommendations: RightSizingRecommendation[];
    total: number;
}

export interface RightSizingSummary {
    totalPotentialMonthlySavings: number;
    byFinding: Record<string, number>;
    byStatus: Record<string, number>;
    savingsByResourceType: Record<string, number>;
    savingsByAccount: Record<string, number>;
    /** Distinct account IDs that appear in the recommendations (any status). Drives the account filter. */
    accountIds: string[];
    lastRunAt: string | null;
}

export interface RightSizingRun {
    id: string;
    tenantId: string;
    status: RunStatus;
    trigger: RunTrigger;
    lookbackDays: number;
    accountsScanned: number;
    resourcesAnalyzed: number;
    recommendationsGenerated: number;
    totalEstimatedSavings: number;
    errors: unknown[];
    startedAt: string;
    finishedAt?: string | null;
    expiresAt?: string | null;
}

export interface RunUpdate {
    status?: RunStatus;
    accountsScanned?: number;
    resourcesAnalyzed?: number;
    recommendationsGenerated?: number;
    totalEstimatedSavings?: number;
    errors?: unknown[];
    finishedAt?: Date | null;
}

export interface IRightSizingRepository {
    listRecommendations(filters: RecommendationFilters): Promise<RecommendationPage>;
    getRecommendation(id: string, tenantId: string): Promise<RightSizingRecommendation | null>;
    upsertRecommendations(items: RecommendationUpsert[], tenantId: string): Promise<number>;
    updateStatus(
        id: string,
        tenantId: string,
        status: RecommendationStatus,
        reviewedBy: string,
        snoozeUntil?: Date | null
    ): Promise<RightSizingRecommendation>;
    getSummary(tenantId: string): Promise<RightSizingSummary>;

    createRun(tenantId: string, trigger: RunTrigger, lookbackDays: number): Promise<RightSizingRun>;
    updateRun(id: string, tenantId: string, updates: RunUpdate): Promise<RightSizingRun>;
    listRuns(tenantId: string, page?: number, limit?: number): Promise<{ runs: RightSizingRun[]; total: number }>;
    getActiveRun(tenantId: string): Promise<RightSizingRun | null>;
}
