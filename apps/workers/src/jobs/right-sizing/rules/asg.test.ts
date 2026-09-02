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
function asg(metadata: Record<string, unknown>): AnalyzableResource {
    return { accountId: 'a1', region: 'us-east-1', resourceType: RESOURCE_TYPES.ASG, resourceId: 'asg-1', metadata };
}

const EC2_CATALOG: CatalogEntry[] = [
    { region: 'us-east-1', serviceCode: 'AmazonEC2', resourceClass: 'm5.large', pricePerHour: 0.096, attributes: { vcpu: 2, memGiB: 8, family: 'm5' } },
    { region: 'us-east-1', serviceCode: 'AmazonEC2', resourceClass: 'm5.xlarge', pricePerHour: 0.192, attributes: { vcpu: 4, memGiB: 16, family: 'm5' } },
    { region: 'us-east-1', serviceCode: 'AmazonEC2', resourceClass: 'm5.2xlarge', pricePerHour: 0.384, attributes: { vcpu: 8, memGiB: 32, family: 'm5' } },
];

const catalog: CatalogApi = {
    getPrice: (service, region, cls) => EC2_CATALOG.find((e) => e.serviceCode === service && e.resourceClass === cls) ?? null,
    listClasses: (service) => (service === 'AmazonEC2' ? EC2_CATALOG : []),
};

describe('ASG rule', () => {
    it('returns null when there is no CPU data', () => {
        expect(evaluate(asg({ instanceType: 'm5.large' }), summary({}), catalog, RIGHT_SIZING_CONFIG)).toBeNull();
    });

    it('returns null when the launch-template instance type cannot be determined', () => {
        expect(evaluate(asg({}), summary({ cpu: sig(50) }), catalog, RIGHT_SIZING_CONFIG)).toBeNull();
    });

    it('defaults desiredCapacity to 1 when not provided and scales cost accordingly', () => {
        const r = evaluate(asg({ instanceType: 'm5.large' }), summary({ cpu: sig(60) }), catalog, RIGHT_SIZING_CONFIG);
        expect(r!.currentConfig.desiredCapacity).toBe(1);
        expect(r!.currentMonthlyCost).toBeCloseTo(0.096 * 730, 3);
    });

    it('multiplies monthly cost by desiredCapacity across the fleet', () => {
        const r = evaluate(asg({ instanceType: 'm5.large', desiredCapacity: 4 }), summary({ cpu: sig(60) }), catalog, RIGHT_SIZING_CONFIG);
        expect(r!.currentMonthlyCost).toBeCloseTo(0.096 * 730 * 4, 3);
    });

    it('flags under-provisioned on high aggregate CPU and recommends a larger launch type', () => {
        const r = evaluate(asg({ instanceType: 'm5.large', desiredCapacity: 3 }), summary({ cpu: sig(90) }), catalog, RIGHT_SIZING_CONFIG);
        expect(r!.finding).toBe('under_provisioned');
        expect(r!.recommendedConfig!.instanceType).toBe('m5.xlarge');
        expect(r!.recommendedConfig!.desiredCapacity).toBe(3);
        expect(r!.riskLevel).toBe('high');
    });

    it('recommends raising capacity when already at the largest catalog entry', () => {
        const r = evaluate(asg({ instanceType: 'm5.2xlarge' }), summary({ cpu: sig(90) }), catalog, RIGHT_SIZING_CONFIG);
        expect(r!.finding).toBe('under_provisioned');
        expect(r!.recommendedConfig).toEqual({ note: 'raise max capacity' });
    });

    it('flags over-provisioned on low aggregate CPU and downsizes the launch type', () => {
        const r = evaluate(asg({ instanceType: 'm5.2xlarge', desiredCapacity: 2 }), summary({ cpu: sig(5) }), catalog, RIGHT_SIZING_CONFIG);
        expect(r!.finding).toBe('over_provisioned');
        expect(r!.recommendedConfig!.instanceType).toBe('m5.large');
        expect(r!.recommendedConfig!.desiredCapacity).toBe(2);
        expect(r!.estimatedMonthlySavings).toBeGreaterThan(0);
    });

    it('falls back to optimized when over-provisioned but no smaller candidate meets the requirement', () => {
        const r = evaluate(asg({ instanceType: 'm5.large' }), summary({ cpu: sig(5) }), catalog, RIGHT_SIZING_CONFIG);
        expect(r!.finding).toBe('optimized');
    });

    it('returns optimized in the mid-range', () => {
        const r = evaluate(asg({ instanceType: 'm5.xlarge' }), summary({ cpu: sig(60) }), catalog, RIGHT_SIZING_CONFIG);
        expect(r!.finding).toBe('optimized');
        expect(r!.estimatedMonthlySavings).toBe(0);
    });

    it('reads capacity fields from PascalCase metadata keys as a fallback', () => {
        const r = evaluate(asg({ InstanceType: 'm5.large', DesiredCapacity: '2', MinSize: 1, MaxSize: 5 }), summary({ cpu: sig(60) }), catalog, RIGHT_SIZING_CONFIG);
        expect(r!.currentConfig).toEqual(expect.objectContaining({ instanceType: 'm5.large', desiredCapacity: 2, minSize: 1, maxSize: 5 }));
    });
});
