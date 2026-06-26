import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { evaluate, computeConfidence, type CatalogApi, type CatalogEntry } from './engine.js';
import { RIGHT_SIZING_CONFIG } from '../config.js';
import { RESOURCE_TYPES, type AnalyzableResource, type MetricsSummary, type SignalSummary } from '../types.js';

const EC2_CATALOG: CatalogEntry[] = [
    { region: 'us-east-1', serviceCode: 'AmazonEC2', resourceClass: 'm5.large', pricePerHour: 0.096, attributes: { vcpu: 2, memGiB: 8, family: 'General purpose' } },
    { region: 'us-east-1', serviceCode: 'AmazonEC2', resourceClass: 'm5.xlarge', pricePerHour: 0.192, attributes: { vcpu: 4, memGiB: 16, family: 'General purpose' } },
    { region: 'us-east-1', serviceCode: 'AmazonEC2', resourceClass: 'm5.2xlarge', pricePerHour: 0.384, attributes: { vcpu: 8, memGiB: 32, family: 'General purpose' } },
    { region: 'us-east-1', serviceCode: 'AmazonEC2', resourceClass: 'm5.4xlarge', pricePerHour: 0.768, attributes: { vcpu: 16, memGiB: 64, family: 'General purpose' } },
];
const EBS_CATALOG: CatalogEntry[] = [
    { region: 'us-east-1', serviceCode: 'AmazonEBS', resourceClass: 'gp2', pricePerGiBMonth: 0.1, attributes: {} },
    { region: 'us-east-1', serviceCode: 'AmazonEBS', resourceClass: 'gp3', pricePerGiBMonth: 0.08, pricePerIopsMonth: 0.005, attributes: {} },
];
const catalog: CatalogApi = {
    getPrice: (s, r, c) => [...EC2_CATALOG, ...EBS_CATALOG].find((e) => e.serviceCode === s && e.resourceClass === c) ?? null,
    listClasses: (s) => (s === 'AmazonEC2' ? EC2_CATALOG : s === 'AmazonEBS' ? EBS_CATALOG : []),
};
const byClass = new Map(EC2_CATALOG.map((e) => [e.resourceClass, e]));

function sig(p95: number): SignalSummary {
    return { avg: p95 * 0.8, p95, p99: p95, max: Math.min(100, p95 * 1.1), count: 300 };
}
function ec2(instanceType: string): AnalyzableResource {
    return { accountId: 'a', region: 'us-east-1', resourceType: RESOURCE_TYPES.EC2, resourceId: 'i-x', metadata: { instanceType } };
}

describe('engine properties', () => {
    it('confidence is always within [0,1]', () => {
        fc.assert(
            fc.property(fc.double({ min: 0, max: 60, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }), (cov, dens) => {
                const c = computeConfidence({ coverageDays: cov, datapointDensity: dens } as MetricsSummary, RIGHT_SIZING_CONFIG);
                expect(c).toBeGreaterThanOrEqual(0);
                expect(c).toBeLessThanOrEqual(1);
            })
        );
    });

    it('confidence is monotonic non-decreasing in coverageDays', () => {
        fc.assert(
            fc.property(
                fc.double({ min: 0, max: 20, noNaN: true }),
                fc.double({ min: 0, max: 20, noNaN: true }),
                fc.double({ min: 0, max: 1, noNaN: true }),
                (a, b, dens) => {
                    const lo = Math.min(a, b);
                    const hi = Math.max(a, b);
                    const cLo = computeConfidence({ coverageDays: lo, datapointDensity: dens } as MetricsSummary, RIGHT_SIZING_CONFIG);
                    const cHi = computeConfidence({ coverageDays: hi, datapointDensity: dens } as MetricsSummary, RIGHT_SIZING_CONFIG);
                    expect(cHi).toBeGreaterThanOrEqual(cLo);
                }
            )
        );
    });

    it('estimatedMonthlySavings is never negative; downsizes never violate the capacity headroom invariant', () => {
        const types = EC2_CATALOG.map((e) => e.resourceClass);
        fc.assert(
            fc.property(
                fc.constantFrom(...types),
                fc.double({ min: 0, max: 100, noNaN: true }),
                fc.double({ min: 1, max: 14, noNaN: true }),
                (instanceType, cpuP95, cov) => {
                    const summary: MetricsSummary = { cpu: sig(cpuP95), coverageDays: cov, datapointDensity: 0.9 };
                    const r = evaluate(ec2(instanceType), summary, catalog, RIGHT_SIZING_CONFIG);
                    if (!r) return;
                    // savings never negative
                    expect(r.estimatedMonthlySavings).toBeGreaterThanOrEqual(0);
                    // capacity invariant on downsize recommendations
                    if (r.finding === 'over_provisioned' && r.recommendedConfig?.instanceType) {
                        const cur = byClass.get(instanceType)!;
                        const rec = byClass.get(r.recommendedConfig.instanceType as string)!;
                        const requiredVcpu = Math.max(1, (cur.attributes.vcpu! * cpuP95) / 100 * RIGHT_SIZING_CONFIG.headroomMultiplier);
                        expect(rec.attributes.vcpu!).toBeGreaterThanOrEqual(requiredVcpu);
                        // downsize must actually be cheaper
                        expect(rec.pricePerHour!).toBeLessThan(cur.pricePerHour!);
                    }
                    // idle always carries a recommendation
                    if (r.finding === 'idle') {
                        expect(r.recommendedConfig).not.toBeNull();
                    }
                }
            )
        );
    });

    it('EBS gp2→gp3 never produces negative savings for any attached volume size', () => {
        fc.assert(
            fc.property(fc.integer({ min: 1, max: 16384 }), (sizeGiB) => {
                const resource: AnalyzableResource = {
                    accountId: 'a',
                    region: 'us-east-1',
                    resourceType: RESOURCE_TYPES.EBS,
                    resourceId: 'vol-x',
                    status: 'in-use',
                    metadata: { volumeType: 'gp2', size: sizeGiB },
                };
                const summary: MetricsSummary = { coverageDays: 14, datapointDensity: 0.9 };
                const r = evaluate(resource, summary, catalog, RIGHT_SIZING_CONFIG);
                expect(r).not.toBeNull();
                expect(r!.finding).toBe('over_provisioned');
                expect(r!.recommendedConfig?.volumeType).toBe('gp3');
                expect(r!.estimatedMonthlySavings).toBeGreaterThanOrEqual(0);
                expect(r!.riskLevel).toBe('low'); // config-based, not escalated by low confidence
            })
        );
    });
});
