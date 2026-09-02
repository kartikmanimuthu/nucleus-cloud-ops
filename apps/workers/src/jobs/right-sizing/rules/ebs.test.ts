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
function ebs(metadata: Record<string, unknown>, status: string | null = 'in-use'): AnalyzableResource {
    return { accountId: 'a1', region: 'us-east-1', resourceType: RESOURCE_TYPES.EBS, resourceId: 'vol-1', metadata, status };
}

const EBS_CATALOG: CatalogEntry[] = [
    { region: 'us-east-1', serviceCode: 'AmazonEBS', resourceClass: 'gp2', pricePerGiBMonth: 0.1, attributes: {} },
    { region: 'us-east-1', serviceCode: 'AmazonEBS', resourceClass: 'gp3', pricePerGiBMonth: 0.08, pricePerIopsMonth: 0.005, attributes: {} },
    { region: 'us-east-1', serviceCode: 'AmazonEBS', resourceClass: 'io1', pricePerGiBMonth: 0.125, pricePerIopsMonth: 0.065, attributes: {} },
];

const catalog: CatalogApi = {
    getPrice: (service, region, cls) => EBS_CATALOG.find((e) => e.serviceCode === service && e.resourceClass === cls) ?? null,
    listClasses: (service) => (service === 'AmazonEBS' ? EBS_CATALOG : []),
};

describe('EBS rule', () => {
    it('returns null when volumeType is missing', () => {
        expect(evaluate(ebs({ size: 100 }), summary({}), catalog, RIGHT_SIZING_CONFIG)).toBeNull();
    });

    it('returns null when size is missing or zero', () => {
        expect(evaluate(ebs({ volumeType: 'gp3' }), summary({}), catalog, RIGHT_SIZING_CONFIG)).toBeNull();
    });

    it('treats a resource with no status as attached by default (metadata fallback)', () => {
        const r = evaluate(ebs({ volumeType: 'gp3', size: 100 }, null), summary({}), catalog, RIGHT_SIZING_CONFIG);
        expect(r!.finding).not.toBe('idle');
    });

    it('flags negligible I/O as idle (review for deletion) once coverage is long enough', () => {
        const r = evaluate(
            ebs({ volumeType: 'gp3', size: 200, iops: 3000 }),
            summary({ diskReadOps: sig(0.1), diskWriteOps: sig(0.1), coverageDays: RIGHT_SIZING_CONFIG.minCoverageDaysHighConfidence }),
            catalog, RIGHT_SIZING_CONFIG
        );
        expect(r!.finding).toBe('idle');
        expect(r!.recommendedConfig).toEqual({ action: 'review_for_deletion' });
        expect(r!.estimatedMonthlySavings).toBeCloseTo(0.08 * 200, 3);
    });

    it('does not flag negligible I/O as idle when coverage is too short', () => {
        const r = evaluate(
            ebs({ volumeType: 'gp3', size: 200 }),
            summary({ diskReadOps: sig(0.1), diskWriteOps: sig(0.1), coverageDays: 1 }),
            catalog, RIGHT_SIZING_CONFIG
        );
        expect(r!.finding).not.toBe('idle');
    });

    it('reduces over-provisioned IOPS on io1 when usage is far below the provisioned amount', () => {
        const r = evaluate(
            ebs({ volumeType: 'io1', size: 100, iops: 10000 }),
            summary({ diskReadOps: sig(50 * RIGHT_SIZING_CONFIG.metricPeriodSeconds), diskWriteOps: sig(0) }),
            catalog, RIGHT_SIZING_CONFIG
        );
        expect(r!.finding).toBe('over_provisioned');
        expect((r!.recommendedConfig!.iops as number)).toBeLessThan(10000);
        expect(r!.recommendedConfig!.volumeType).toBe('io1');
    });

    it('does not reduce IOPS when usage is close to the provisioned amount', () => {
        const r = evaluate(
            ebs({ volumeType: 'io1', size: 100, iops: 1000 }),
            summary({ diskReadOps: sig(400 * RIGHT_SIZING_CONFIG.metricPeriodSeconds), diskWriteOps: sig(0) }),
            catalog, RIGHT_SIZING_CONFIG
        );
        expect(r!.finding).toBe('optimized');
    });

    it('floors the recommended gp3 IOPS at the free baseline (3000)', () => {
        const r = evaluate(
            ebs({ volumeType: 'gp3', size: 500, iops: 16000 }),
            summary({ diskReadOps: sig(1), diskWriteOps: sig(0) }),
            catalog, RIGHT_SIZING_CONFIG
        );
        expect(r!.finding).toBe('over_provisioned');
        expect(r!.recommendedConfig!.iops).toBe(3000);
    });

    it('skips the IOPS check when there is no I/O metric data at all', () => {
        const r = evaluate(ebs({ volumeType: 'io1', size: 100, iops: 10000 }), summary({}), catalog, RIGHT_SIZING_CONFIG);
        expect(r!.finding).toBe('optimized');
    });

    it('returns optimized for an appropriately configured gp3 volume', () => {
        const r = evaluate(
            ebs({ volumeType: 'gp3', size: 100, iops: 3000 }),
            summary({ diskReadOps: sig(2500 * RIGHT_SIZING_CONFIG.metricPeriodSeconds), diskWriteOps: sig(0) }),
            catalog, RIGHT_SIZING_CONFIG
        );
        expect(r!.finding).toBe('optimized');
        expect(r!.estimatedMonthlySavings).toBe(0);
    });

    it('prioritizes unattached-idle over the gp2→gp3 conversion', () => {
        const r = evaluate(ebs({ volumeType: 'gp2', size: 100 }, 'available'), summary({}), catalog, RIGHT_SIZING_CONFIG);
        expect(r!.finding).toBe('idle');
        expect(r!.recommendedConfig).toEqual({ action: 'snapshot_and_delete' });
    });
});
