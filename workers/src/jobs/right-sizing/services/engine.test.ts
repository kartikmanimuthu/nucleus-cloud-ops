import { describe, it, expect } from 'vitest';
import { evaluate, computeConfidence, type CatalogApi, type CatalogEntry } from './engine.js';
import { RIGHT_SIZING_CONFIG } from '../config.js';
import { RESOURCE_TYPES, type AnalyzableResource, type MetricsSummary, type SignalSummary } from '../types.js';

function sig(p95: number, opts: Partial<SignalSummary> = {}): SignalSummary {
    return { avg: opts.avg ?? p95, p95, p99: opts.p99 ?? p95, max: opts.max ?? p95, count: opts.count ?? 300 };
}
function summary(over: Partial<MetricsSummary>): MetricsSummary {
    return { coverageDays: 14, datapointDensity: 0.9, ...over };
}

const EC2_CATALOG: CatalogEntry[] = [
    { region: 'us-east-1', serviceCode: 'AmazonEC2', resourceClass: 'm5.large', pricePerHour: 0.096, attributes: { vcpu: 2, memGiB: 8, family: 'General purpose' } },
    { region: 'us-east-1', serviceCode: 'AmazonEC2', resourceClass: 'm5.xlarge', pricePerHour: 0.192, attributes: { vcpu: 4, memGiB: 16, family: 'General purpose' } },
    { region: 'us-east-1', serviceCode: 'AmazonEC2', resourceClass: 'm5.2xlarge', pricePerHour: 0.384, attributes: { vcpu: 8, memGiB: 32, family: 'General purpose' } },
];
const EBS_CATALOG: CatalogEntry[] = [
    { region: 'us-east-1', serviceCode: 'AmazonEBS', resourceClass: 'gp2', pricePerGiBMonth: 0.1, attributes: {} },
    { region: 'us-east-1', serviceCode: 'AmazonEBS', resourceClass: 'gp3', pricePerGiBMonth: 0.08, pricePerIopsMonth: 0.005, attributes: {} },
];

const catalog: CatalogApi = {
    getPrice: (service, region, cls) =>
        [...EC2_CATALOG, ...EBS_CATALOG].find((e) => e.serviceCode === service && e.resourceClass === cls) ?? null,
    listClasses: (service) =>
        service === 'AmazonEC2' ? EC2_CATALOG : service === 'AmazonEBS' ? EBS_CATALOG : [],
};

function ec2(metadata: Record<string, unknown>): AnalyzableResource {
    return { accountId: 'a1', region: 'us-east-1', resourceType: RESOURCE_TYPES.EC2, resourceId: 'i-1', metadata };
}

describe('computeConfidence', () => {
    it('is monotonic in coverageDays', () => {
        const c1 = computeConfidence(summary({ coverageDays: 1 }), RIGHT_SIZING_CONFIG);
        const c2 = computeConfidence(summary({ coverageDays: 7 }), RIGHT_SIZING_CONFIG);
        expect(c2).toBeGreaterThanOrEqual(c1);
        expect(c1).toBeGreaterThanOrEqual(0);
        expect(c2).toBeLessThanOrEqual(1);
    });
});

describe('EC2 rule', () => {
    it('flags over-provisioned and downsizes to a smaller same-family type', () => {
        const r = evaluate(ec2({ instanceType: 'm5.2xlarge' }), summary({ cpu: sig(10) }), catalog, RIGHT_SIZING_CONFIG);
        expect(r!.finding).toBe('over_provisioned');
        expect(r!.recommendedConfig!.instanceType).toBe('m5.large');
        expect(r!.estimatedMonthlySavings).toBeGreaterThan(0);
        // never recommends less capacity than required headroom
        expect(r!.recommendedConfig!.vcpu as number).toBeGreaterThanOrEqual(1);
    });

    it('flags idle on near-zero cpu + network', () => {
        const r = evaluate(ec2({ instanceType: 'm5.large' }), summary({ cpu: sig(1), networkIn: sig(10), networkOut: sig(10) }), catalog, RIGHT_SIZING_CONFIG);
        expect(r!.finding).toBe('idle');
        expect(r!.estimatedMonthlySavings).toBeCloseTo(0.096 * 730, 3);
    });

    it('flags under-provisioned at high cpu and scales up (savings 0)', () => {
        const r = evaluate(ec2({ instanceType: 'm5.large' }), summary({ cpu: sig(95) }), catalog, RIGHT_SIZING_CONFIG);
        expect(r!.finding).toBe('under_provisioned');
        expect(r!.recommendedConfig!.instanceType).toBe('m5.xlarge');
        expect(r!.estimatedMonthlySavings).toBe(0);
        expect(r!.riskLevel).toBe('high');
    });

    it('returns optimized in the mid-range', () => {
        const r = evaluate(ec2({ instanceType: 'm5.large' }), summary({ cpu: sig(60) }), catalog, RIGHT_SIZING_CONFIG);
        expect(r!.finding).toBe('optimized');
        expect(r!.estimatedMonthlySavings).toBe(0);
    });

    it('returns null when no CPU data', () => {
        expect(evaluate(ec2({ instanceType: 'm5.large' }), summary({}), catalog, RIGHT_SIZING_CONFIG)).toBeNull();
    });

    it('escalates risk to high when confidence is low', () => {
        const r = evaluate(ec2({ instanceType: 'm5.2xlarge' }), summary({ cpu: sig(10), coverageDays: 0.5, datapointDensity: 0.05 }), catalog, RIGHT_SIZING_CONFIG);
        expect(r!.finding).toBe('over_provisioned');
        expect(r!.riskLevel).toBe('high');
    });
});

describe('EBS rule', () => {
    function ebs(metadata: Record<string, unknown>): AnalyzableResource {
        return { accountId: 'a1', region: 'us-east-1', resourceType: RESOURCE_TYPES.EBS, resourceId: 'vol-1', metadata };
    }
    it('recommends gp2 → gp3 with positive savings, low risk, high confidence', () => {
        const r = evaluate(ebs({ volumeType: 'gp2', size: 500, state: 'in-use' }), summary({}), catalog, RIGHT_SIZING_CONFIG);
        expect(r!.finding).toBe('over_provisioned');
        expect(r!.recommendedConfig!.volumeType).toBe('gp3');
        expect(r!.riskLevel).toBe('low'); // forceRisk prevents escalation despite no metrics
        expect(r!.confidence).toBeCloseTo(0.95, 5);
        expect(r!.estimatedMonthlySavings).toBeCloseTo((0.1 - 0.08) * 500, 3);
    });

    it('flags unattached volume as idle with full-cost savings', () => {
        const r = evaluate(ebs({ volumeType: 'gp3', size: 100, state: 'available' }), summary({}), catalog, RIGHT_SIZING_CONFIG);
        expect(r!.finding).toBe('idle');
        expect(r!.estimatedMonthlySavings).toBeCloseTo(0.08 * 100, 3);
    });
});
