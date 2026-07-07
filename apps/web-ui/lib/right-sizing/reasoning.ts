import { RIGHT_SIZING_CONFIG } from './config';
import { RESOURCE_TYPES, type ResourceTypeKey, type MetricsSummary } from './types';

const CPU_THRESHOLDS: Partial<Record<ResourceTypeKey, { cpuOverProvisionedPct: number; cpuUnderProvisionedPct: number }>> = {
    [RESOURCE_TYPES.EC2]: RIGHT_SIZING_CONFIG.ec2,
    [RESOURCE_TYPES.RDS]: RIGHT_SIZING_CONFIG.rds,
    [RESOURCE_TYPES.ASG]: RIGHT_SIZING_CONFIG.asg,
};

/**
 * Plain-language breakdown of why a finding fired: the CPU threshold comparison (for resource
 * types that have one) plus a confidence/coverage line. Reads straight from RIGHT_SIZING_CONFIG
 * so the numbers shown always match the engine that actually produced the recommendation.
 * Idle-finding specifics (network-byte threshold, EBS "available" state) aren't broken down
 * here — only the over/under-provisioned CPU comparison and confidence drivers.
 */
export function buildReasoningLines(resourceType: string, metricsSummary: MetricsSummary): string[] {
    const lines: string[] = [];
    const thresholds = CPU_THRESHOLDS[resourceType as ResourceTypeKey];
    const cpu = metricsSummary.cpu;

    if (thresholds && cpu) {
        const { cpuOverProvisionedPct, cpuUnderProvisionedPct } = thresholds;
        const verdict =
            cpu.p95 < cpuOverProvisionedPct
                ? `below the ${cpuOverProvisionedPct}% over-provisioned threshold.`
                : cpu.p95 > cpuUnderProvisionedPct
                  ? `above the ${cpuUnderProvisionedPct}% under-provisioned threshold.`
                  : `within the normal ${cpuOverProvisionedPct}–${cpuUnderProvisionedPct}% range.`;
        lines.push(`CPU avg ${cpu.avg.toFixed(1)}%, p95 ${cpu.p95.toFixed(1)}% — ${verdict}`);
    }

    const { coverageDays, datapointDensity } = metricsSummary;
    const { lookbackDays, minCoverageDaysHighConfidence, minDatapointDensityHighConfidence } = RIGHT_SIZING_CONFIG;
    const highConfidence =
        coverageDays >= minCoverageDaysHighConfidence && datapointDensity >= minDatapointDensityHighConfidence;
    const coverageDesc = `${coverageDays.toFixed(1)} of ${lookbackDays} lookback days observed (${Math.round(datapointDensity * 100)}% density)`;
    lines.push(
        highConfidence
            ? `${coverageDesc} — high confidence.`
            : `${coverageDesc} — below the ${minCoverageDaysHighConfidence}-day / ${Math.round(minDatapointDensityHighConfidence * 100)}% threshold for high confidence.`
    );

    return lines;
}
