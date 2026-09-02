import { describe, it, expect } from 'vitest';
import { evaluate, type CatalogApi, type CatalogEntry } from '../services/engine.js';
import { RIGHT_SIZING_CONFIG } from '../config.js';
import { RESOURCE_TYPES, type AnalyzableResource, type MetricsSummary, type SignalSummary } from '../types.js';

function sig(p95: number, opts: Partial<SignalSummary> = {}): SignalSummary {
    return { avg: opts.avg ?? p95, p95, p99: opts.p99 ?? p95, max: opts.max ?? p95, count: opts.count ?? 300 };
}
function summary(over: Partial<MetricsSummary>): MetricsSummary {
    return { coverageDays: 14, datapointDensity: 0.9, ...over };
}
function rds(metadata: Record<string, unknown>): AnalyzableResource {
    return { accountId: 'a1', region: 'us-east-1', resourceType: RESOURCE_TYPES.RDS, resourceId: 'db-1', metadata };
}

const GIB = 1024 * 1024 * 1024;

const RDS_CATALOG: CatalogEntry[] = [
    { region: 'us-east-1', serviceCode: 'AmazonRDS', resourceClass: 'db.r5.large', pricePerHour: 0.24, attributes: { vcpu: 2, memGiB: 16, family: 'r5' } },
    { region: 'us-east-1', serviceCode: 'AmazonRDS', resourceClass: 'db.r5.xlarge', pricePerHour: 0.48, attributes: { vcpu: 4, memGiB: 32, family: 'r5' } },
    { region: 'us-east-1', serviceCode: 'AmazonRDS', resourceClass: 'db.r5.2xlarge', pricePerHour: 0.96, attributes: { vcpu: 8, memGiB: 64, family: 'r5' } },
];

const catalog: CatalogApi = {
    getPrice: (service, region, cls) => RDS_CATALOG.find((e) => e.serviceCode === service && e.resourceClass === cls) ?? null,
    listClasses: (service) => (service === 'AmazonRDS' ? RDS_CATALOG : []),
};

describe('RDS rule', () => {
    it('returns null when there is no CPU data', () => {
        expect(evaluate(rds({ dbInstanceClass: 'db.r5.large' }), summary({}), catalog, RIGHT_SIZING_CONFIG)).toBeNull();
    });

    it('returns null when the dbInstanceClass cannot be determined', () => {
        expect(evaluate(rds({}), summary({ cpu: sig(50) }), catalog, RIGHT_SIZING_CONFIG)).toBeNull();
    });

    it('flags idle when connections are ~0 and CPU is negligible', () => {
        const r = evaluate(rds({ dbInstanceClass: 'db.r5.large' }), summary({ cpu: sig(1), connections: sig(0) }), catalog, RIGHT_SIZING_CONFIG);
        expect(r!.finding).toBe('idle');
        expect(r!.estimatedMonthlySavings).toBeCloseTo(0.24 * 730, 3);
    });

    it('does not flag idle when there are active connections, even with low CPU', () => {
        const r = evaluate(rds({ dbInstanceClass: 'db.r5.large' }), summary({ cpu: sig(1), connections: sig(5), freeableMemory: sig(8 * GIB) }), catalog, RIGHT_SIZING_CONFIG);
        expect(r!.finding).not.toBe('idle');
    });

    it('flags under-provisioned on high CPU and scales up within the same family', () => {
        const r = evaluate(rds({ dbInstanceClass: 'db.r5.large' }), summary({ cpu: sig(90), freeableMemory: sig(8 * GIB) }), catalog, RIGHT_SIZING_CONFIG);
        expect(r!.finding).toBe('under_provisioned');
        expect(r!.recommendedConfig!.dbInstanceClass).toBe('db.r5.xlarge');
        expect(r!.riskLevel).toBe('high');
    });

    it('flags under-provisioned when memory is nearly exhausted, even with moderate CPU', () => {
        const r = evaluate(rds({ dbInstanceClass: 'db.r5.large' }), summary({ cpu: sig(50), freeableMemory: sig(0.5 * GIB) }), catalog, RIGHT_SIZING_CONFIG);
        expect(r!.finding).toBe('under_provisioned');
    });

    it('reports no recommended class when already the largest catalog entry', () => {
        const r = evaluate(rds({ dbInstanceClass: 'db.r5.2xlarge' }), summary({ cpu: sig(90), freeableMemory: sig(30 * GIB) }), catalog, RIGHT_SIZING_CONFIG);
        expect(r!.finding).toBe('under_provisioned');
        expect(r!.recommendedConfig).toBeNull();
    });

    it('flags over-provisioned on low CPU with ample free memory and downsizes', () => {
        const r = evaluate(rds({ dbInstanceClass: 'db.r5.2xlarge' }), summary({ cpu: sig(5), freeableMemory: sig(60 * GIB) }), catalog, RIGHT_SIZING_CONFIG);
        expect(r!.finding).toBe('over_provisioned');
        expect(r!.recommendedConfig!.dbInstanceClass).toBe('db.r5.large');
        expect(r!.estimatedMonthlySavings).toBeGreaterThan(0);
    });

    it('treats unknown free-memory (no CloudWatch data) as over-provisioned-eligible', () => {
        const r = evaluate(rds({ dbInstanceClass: 'db.r5.2xlarge' }), summary({ cpu: sig(5) }), catalog, RIGHT_SIZING_CONFIG);
        expect(r!.finding).toBe('over_provisioned');
    });

    it('falls back to optimized when over-provisioned but no smaller candidate meets the requirement', () => {
        const r = evaluate(rds({ dbInstanceClass: 'db.r5.large' }), summary({ cpu: sig(5), freeableMemory: sig(15 * GIB) }), catalog, RIGHT_SIZING_CONFIG);
        expect(r!.finding).toBe('optimized');
    });

    it('returns optimized in the mid-range (moderate CPU, moderate free memory)', () => {
        const r = evaluate(rds({ dbInstanceClass: 'db.r5.xlarge' }), summary({ cpu: sig(60), connections: sig(5), freeableMemory: sig(0.3 * 32 * GIB) }), catalog, RIGHT_SIZING_CONFIG);
        expect(r!.finding).toBe('optimized');
        expect(r!.estimatedMonthlySavings).toBe(0);
    });
});
