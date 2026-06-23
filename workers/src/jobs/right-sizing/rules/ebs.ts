// workers/src/jobs/right-sizing/rules/ebs.ts
//
// EBS volume right-sizing rule (RS-013). Pure.
// Evaluates (in priority order): idle/unattached → gp2→gp3 conversion → over-provisioned IOPS.
import type { RuleContext, RuleOutput, CatalogEntry } from '../services/engine.js';
import type { ResourceConfig } from '../types.js';

const SERVICE = 'AmazonEBS';
const GP3_FREE_IOPS = 3000;

function num(md: Record<string, unknown>, keys: string[]): number | undefined {
    for (const k of keys) {
        const v = md[k];
        if (typeof v === 'number') return v;
        if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
    }
    return undefined;
}
function str(md: Record<string, unknown>, keys: string[]): string | undefined {
    for (const k of keys) {
        const v = md[k];
        if (typeof v === 'string' && v) return v;
    }
    return undefined;
}

/** Monthly cost of a volume config given its pricing entry. */
function volumeMonthly(entry: CatalogEntry | null, sizeGiB: number, volumeType: string, iops?: number): number | null {
    if (!entry || entry.pricePerGiBMonth == null) return null;
    let cost = entry.pricePerGiBMonth * sizeGiB;
    if (entry.pricePerIopsMonth != null && iops) {
        const billable = volumeType === 'gp3' ? Math.max(0, iops - GP3_FREE_IOPS) : iops;
        cost += entry.pricePerIopsMonth * billable;
    }
    return cost;
}

export function evaluateEbs(ctx: RuleContext): RuleOutput | null {
    const { resource, summary, config, catalog } = ctx;
    const md = resource.metadata;
    const region = resource.region;

    const volumeType = str(md, ['volumeType', 'VolumeType']);
    const sizeGiB = num(md, ['size', 'Size', 'sizeGiB']) ?? 0;
    const iops = num(md, ['iops', 'Iops']);
    // Attachment state lives in the inventory `status` column (fallback to metadata).
    const state = resource.status ?? str(md, ['state', 'State', 'status']);
    if (!volumeType || !sizeGiB) return null;

    const entry = catalog.getPrice(SERVICE, region, volumeType);
    const currentConfig: ResourceConfig = { volumeType, sizeGiB, iops };
    const currentMonthly = volumeMonthly(entry, sizeGiB, volumeType, iops);

    const reads = summary.diskReadOps;
    const writes = summary.diskWriteOps;
    const hasIoData = !!(reads || writes);
    const ioP95 = (reads?.p95 ?? 0) + (writes?.p95 ?? 0);
    const attached = state ? state === 'in-use' : true;

    // ---- 1. unattached / idle ----
    if (!attached) {
        return {
            finding: 'idle',
            currentConfig,
            recommendedConfig: { action: 'snapshot_and_delete' },
            riskLevel: 'medium',
            rationale: `Volume is unattached (state "${state}"). Snapshot and delete to stop paying for ${sizeGiB} GiB.`,
            currentMonthlyCost: currentMonthly,
            recommendedMonthlyCost: 0,
            savingsIsFullCurrent: true,
            forceRisk: true,
            confidenceOverride: 0.9,
        };
    }
    if (hasIoData && ioP95 < 1 && summary.coverageDays >= config.minCoverageDaysHighConfidence) {
        return {
            finding: 'idle',
            currentConfig,
            recommendedConfig: { action: 'review_for_deletion' },
            riskLevel: 'medium',
            rationale:
                `Volume has negligible I/O (p95 ${ioP95.toFixed(2)} ops) over ${summary.coverageDays.toFixed(1)}d. ` +
                `Review whether it is still needed.`,
            currentMonthlyCost: currentMonthly,
            recommendedMonthlyCost: 0,
            savingsIsFullCurrent: true,
        };
    }

    // ---- 2. gp2 → gp3 (config-based, no metrics required) ----
    if (config.ebs.evaluateGp2ToGp3 && volumeType === 'gp2') {
        const gp3 = catalog.getPrice(SERVICE, region, 'gp3');
        const gp3Monthly = volumeMonthly(gp3, sizeGiB, 'gp3', iops);
        return {
            finding: 'over_provisioned',
            currentConfig,
            recommendedConfig: { volumeType: 'gp3', sizeGiB, iops: iops && iops > GP3_FREE_IOPS ? iops : undefined },
            riskLevel: 'low',
            rationale: `gp2 → gp3 migration: gp3 is cheaper per GiB at equivalent baseline performance. Low-risk, high-confidence saving.`,
            currentMonthlyCost: currentMonthly,
            recommendedMonthlyCost: gp3Monthly,
            forceRisk: true,
            confidenceOverride: 0.95,
        };
    }

    // ---- 3. over-provisioned IOPS (io1/io2/gp3) ----
    if (iops && (volumeType === 'io1' || volumeType === 'io2' || volumeType === 'gp3') && hasIoData) {
        // diskReadOps/diskWriteOps are Sum per period → ops/sec ≈ sum / periodSeconds.
        const usedIopsP95 = ioP95 / config.metricPeriodSeconds;
        const headroomIops = Math.max(GP3_FREE_IOPS, Math.ceil(usedIopsP95 * config.headroomMultiplier));
        if (iops > headroomIops * config.ebs.iopsOverProvisionFactor) {
            const recIops = volumeType === 'gp3' ? Math.max(GP3_FREE_IOPS, headroomIops) : headroomIops;
            const recommendedConfig: ResourceConfig = { volumeType, sizeGiB, iops: recIops };
            return {
                finding: 'over_provisioned',
                currentConfig,
                recommendedConfig,
                riskLevel: 'medium',
                rationale:
                    `Provisioned IOPS (${iops}) far exceed used (p95 ~${usedIopsP95.toFixed(0)}/s). ` +
                    `Reduce to ${recIops} IOPS (${config.headroomMultiplier}× headroom).`,
                currentMonthlyCost: currentMonthly,
                recommendedMonthlyCost: volumeMonthly(entry, sizeGiB, volumeType, recIops),
            };
        }
    }

    // ---- optimized ----
    return {
        finding: 'optimized',
        currentConfig,
        recommendedConfig: null,
        riskLevel: 'low',
        rationale: `Volume (${volumeType}, ${sizeGiB} GiB) is appropriately configured.`,
        currentMonthlyCost: currentMonthly,
        recommendedMonthlyCost: currentMonthly,
    };
}
