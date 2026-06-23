// workers/src/jobs/right-sizing/services/engine.ts
//
// RecommendationEngine core (RS-010). Pure & deterministic — no I/O.
// Dispatches a resource + its metric summary to the per-type rule module, then attaches
// confidence, savings, and (when the rule didn't already) a risk adjustment.
//
// Pricing is provided via an injected synchronous CatalogApi (the worker pre-loads the
// region's pricing into a Map), keeping this module unit-testable.
import {
    RESOURCE_TYPES,
    type AnalyzableResource,
    type MetricsSummary,
    type RecommendationOutput,
    type RiskLevel,
} from '../types.js';
import type { RightSizingConfig } from '../config.js';
import { evaluateEc2 } from '../rules/ec2.js';
import { evaluateRds } from '../rules/rds.js';
import { evaluateEbs } from '../rules/ebs.js';
import { evaluateAsg } from '../rules/asg.js';

export interface CatalogEntry {
    region: string;
    serviceCode: string;
    resourceClass: string;
    pricePerHour?: number | null;
    pricePerGiBMonth?: number | null;
    pricePerIopsMonth?: number | null;
    attributes: { vcpu?: number; memGiB?: number; family?: string; [k: string]: unknown };
}

export interface CatalogApi {
    getPrice(serviceCode: string, region: string, resourceClass: string): CatalogEntry | null;
    listClasses(serviceCode: string, region: string): CatalogEntry[];
}

export interface RuleContext {
    resource: AnalyzableResource;
    summary: MetricsSummary;
    config: RightSizingConfig;
    catalog: CatalogApi;
}

/** What a rule module returns. The engine fills in confidence + savings. */
export interface RuleOutput {
    finding: RecommendationOutput['finding'];
    currentConfig: RecommendationOutput['currentConfig'];
    recommendedConfig?: RecommendationOutput['recommendedConfig'];
    riskLevel: RiskLevel;
    rationale: string;
    currentMonthlyCost?: number | null;
    recommendedMonthlyCost?: number | null;
    /** Set when the rule deletes/terminates a resource — savings is the full current cost. */
    savingsIsFullCurrent?: boolean;
    /** Config-based rules (e.g. gp2→gp3, unattached) don't depend on metric coverage —
     *  set this so the engine keeps the rule's risk instead of escalating on low confidence. */
    forceRisk?: boolean;
    /** Override the metric-derived confidence (for deterministic, non-metric findings). */
    confidenceOverride?: number;
}

export type RuleFn = (ctx: RuleContext) => RuleOutput | null;

const RULES: Record<string, RuleFn> = {
    [RESOURCE_TYPES.EC2]: evaluateEc2,
    [RESOURCE_TYPES.RDS]: evaluateRds,
    [RESOURCE_TYPES.EBS]: evaluateEbs,
    [RESOURCE_TYPES.ASG]: evaluateAsg,
};

function clamp01(n: number): number {
    return Math.min(1, Math.max(0, n));
}

/** Confidence in [0,1] from data coverage + density. Monotonic in coverageDays. */
export function computeConfidence(summary: MetricsSummary, config: RightSizingConfig): number {
    const coverageScore = clamp01(summary.coverageDays / config.minCoverageDaysHighConfidence);
    const densityScore = clamp01(summary.datapointDensity / config.minDatapointDensityHighConfidence);
    return clamp01(0.5 * coverageScore + 0.5 * densityScore);
}

export function evaluate(
    resource: AnalyzableResource,
    summary: MetricsSummary,
    catalog: CatalogApi,
    config: RightSizingConfig
): RecommendationOutput | null {
    const rule = RULES[resource.resourceType];
    if (!rule) return null;

    const out = rule({ resource, summary, config, catalog });
    if (!out) return null;

    const confidence = out.confidenceOverride ?? computeConfidence(summary, config);

    // Low confidence escalates risk — a thin data window is itself a risk — unless the
    // rule is config-based (forceRisk) and doesn't depend on metric coverage.
    let riskLevel = out.riskLevel;
    if (!out.forceRisk && confidence < config.lowConfidenceRiskThreshold && riskLevel !== 'high') {
        riskLevel = 'high';
    }

    const current = out.currentMonthlyCost ?? null;
    const recommended = out.recommendedMonthlyCost ?? null;
    let estimatedMonthlySavings = 0;
    if (out.savingsIsFullCurrent && current != null) {
        estimatedMonthlySavings = current;
    } else if (current != null && recommended != null) {
        estimatedMonthlySavings = Math.max(0, current - recommended);
    }

    return {
        accountId: resource.accountId,
        region: resource.region,
        resourceType: resource.resourceType,
        resourceId: resource.resourceId,
        name: resource.name ?? null,
        finding: out.finding,
        currentConfig: out.currentConfig,
        recommendedConfig: out.recommendedConfig ?? null,
        metricsSummary: summary,
        lookbackDays: config.lookbackDays,
        currency: 'USD',
        currentMonthlyCost: current,
        recommendedMonthlyCost: recommended,
        estimatedMonthlySavings,
        confidence,
        riskLevel,
        rationale: out.rationale,
        source: 'cloudwatch',
    };
}
