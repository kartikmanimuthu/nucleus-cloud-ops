/**
 * ICapacityPlanningRepository
 *
 * Contract for the Capacity Planning report (SA-004) — the "installed vs.
 * utilised vs. peak vs. >70% breach" companion to Scale Sentinel's scaling
 * event log. Reads `capacity_utilization_samples`, `capacity_planning_runs`.
 *
 * Multi-tenant safety: every query goes through getTenantClient(tenantId).
 * Read-only by design — written exclusively by the worker's raw-pg writer.
 */

// Reused verbatim from Right Sizing — {avg,p95,p99,max,count} is domain-agnostic,
// no reason for this module to define its own copy.
import type { SignalSummary } from '@/lib/right-sizing/types';

export type CapacityResourceType = 'ecs' | 'asg';
export type CapacityPlanningRunStatus = 'queued' | 'running' | 'completed' | 'failed';
export type CapacityPlanningRunTrigger = 'schedule' | 'manual';

export interface CapacityPlanningFilters {
    tenantId: string;
    accountId?: string;
    region?: string;
    resourceType?: CapacityResourceType | CapacityResourceType[];
    searchTerm?: string;
    dateFrom?: string;
    dateTo?: string;
    page?: number;
    limit?: number;
}

/** One row per resource: installed capacity, avg/peak utilisation over the
 *  filtered window, and how many hourly buckets breached the threshold. */
export interface CapacityUtilizationSummaryRow {
    resourceType: CapacityResourceType;
    resourceId: string;
    accountId: string;
    region: string;
    clusterName?: string | null;
    serviceName?: string | null;
    asgName?: string | null;
    displayName: string;
    /** Most recently observed installed size — see postgres.ts for why this
     *  uses MAX() rather than "the latest row's value" (a documented simplification). */
    installedVcpu?: number | null;
    installedMemGiB?: number | null;
    cpuAvg?: number | null;
    cpuMax?: number | null;
    memAvg?: number | null;
    memMax?: number | null;
    breachCount: number;
    firstSampleAt: string;
    lastSampleAt: string;
}

export interface CapacityUtilizationSummaryPage {
    resources: CapacityUtilizationSummaryRow[];
    total: number;
}

/** One row per (resource, metric, hour) that crossed the threshold — mirrors
 *  the reference workbook's "Breach Instances" sheet exactly. */
export interface CapacityBreachInstance {
    resourceType: CapacityResourceType;
    resourceId: string;
    accountId: string;
    region: string;
    displayName: string;
    metric: 'cpu' | 'mem';
    utilizationPercent: number;
    bucketStartUtc: string;
}

export interface CapacityBreachPage {
    breaches: CapacityBreachInstance[];
    total: number;
}

/**
 * One resource's full detail — the Right-Sizing-detail-page equivalent for
 * this domain. Percentiles are computed at READ time (Postgres
 * PERCENTILE_CONT over the stored hourly buckets), not persisted — unlike
 * Right Sizing, which computes them once in the worker from raw per-datapoint
 * CloudWatch series and discards the raw data. This module never has raw
 * per-datapoint data to discard: capacity_utilization_samples only ever
 * stores hourly avg/max, so "the distribution of hourly values across the
 * observed window" is the finest-grained percentile available, and it's
 * cheap enough to compute on every page load rather than persist.
 */
export interface CapacityResourceDetail {
    resourceType: CapacityResourceType;
    resourceId: string;
    accountId: string;
    region: string;
    displayName: string;
    clusterName?: string | null;
    serviceName?: string | null;
    asgName?: string | null;
    installedVcpu?: number | null;
    installedMemGiB?: number | null;
    firstSampleAt: string;
    lastSampleAt: string;
    sampleCount: number;
    breachCount: number;
    metrics: {
        cpu?: SignalSummary | null;
        memory?: SignalSummary | null;
    };
}

export interface CapacityPlanningRun {
    id: string;
    tenantId: string;
    status: CapacityPlanningRunStatus;
    trigger: CapacityPlanningRunTrigger;
    accountsScanned: number;
    resourcesScanned: number;
    samplesWritten: number;
    errors: unknown[];
    startedAt: string;
    finishedAt?: string | null;
}

export interface ICapacityPlanningRepository {
    getUtilizationSummary(filters: CapacityPlanningFilters, thresholdPercent?: number): Promise<CapacityUtilizationSummaryPage>;
    listBreachInstances(filters: CapacityPlanningFilters, thresholdPercent?: number): Promise<CapacityBreachPage>;
    listRuns(tenantId: string, page?: number, limit?: number): Promise<{ runs: CapacityPlanningRun[]; total: number }>;
    getActiveRun(tenantId: string): Promise<CapacityPlanningRun | null>;
    /** One resource's full detail (metadata + percentile metrics) for the
     *  Right-Sizing-style detail page. `resourceId` is an exact match, unlike
     *  the fuzzy `searchTerm` the other methods use — this is a lookup, not a
     *  search. Returns null if no samples exist for that resource. */
    getResourceDetail(filters: CapacityPlanningFilters, resourceId: string): Promise<CapacityResourceDetail | null>;
}
