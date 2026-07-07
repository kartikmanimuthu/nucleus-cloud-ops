import { describe, it, expect } from 'vitest';
import { buildReasoningLines } from './reasoning';
import { RESOURCE_TYPES } from './types';
import type { MetricsSummary } from './types';

const sig = (avg: number, p95: number) => ({ avg, p95, p99: p95, max: p95, count: 232 });

describe('buildReasoningLines', () => {
    it('flags EC2 CPU below the over-provisioned threshold', () => {
        const summary: MetricsSummary = { cpu: sig(18.3, 25.5), coverageDays: 9.67, datapointDensity: 0.69 };
        const lines = buildReasoningLines(RESOURCE_TYPES.EC2, summary);
        expect(lines[0]).toContain('below the 40% over-provisioned threshold');
    });

    it('flags EC2 CPU above the under-provisioned threshold', () => {
        const summary: MetricsSummary = { cpu: sig(90, 95), coverageDays: 14, datapointDensity: 1 };
        const lines = buildReasoningLines(RESOURCE_TYPES.EC2, summary);
        expect(lines[0]).toContain('above the 85% under-provisioned threshold');
    });

    it('reports high confidence when coverage and density both clear the threshold', () => {
        const summary: MetricsSummary = { cpu: sig(50, 60), coverageDays: 14, datapointDensity: 1 };
        const lines = buildReasoningLines(RESOURCE_TYPES.EC2, summary);
        expect(lines[1]).toContain('high confidence');
    });

    it('reports low confidence when coverage is below the threshold', () => {
        const summary: MetricsSummary = { cpu: sig(50, 60), coverageDays: 9.67, datapointDensity: 0.69 };
        const lines = buildReasoningLines(RESOURCE_TYPES.EC2, summary);
        expect(lines[1]).toContain('below the 7-day / 80% threshold');
    });

    it('omits the CPU line for EBS (no CPU-based threshold)', () => {
        const summary: MetricsSummary = { coverageDays: 14, datapointDensity: 1 };
        const lines = buildReasoningLines(RESOURCE_TYPES.EBS, summary);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('high confidence');
    });
});
