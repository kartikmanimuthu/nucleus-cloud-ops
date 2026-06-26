// workers/src/jobs/right-sizing/rules/asg.ts
//
// Auto Scaling Group right-sizing rule (RS-014). Pure.
// Uses aggregate CPU to recommend a smaller/larger launch-template instance type
// (reusing the EC2 mapping) and an optional capacity adjustment.
import { HOURS_PER_MONTH } from '../config.js';
import type { RuleContext, RuleOutput, CatalogEntry } from '../services/engine.js';
import type { ResourceConfig } from '../types.js';
import { pickSmaller, pickLarger, type CapacityRequirement } from './mapping.js';

const SERVICE = 'AmazonEC2';

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

export function evaluateAsg(ctx: RuleContext): RuleOutput | null {
    const { resource, summary, config, catalog } = ctx;
    const cpu = summary.cpu;
    if (!cpu) return null;

    const md = resource.metadata;
    const region = resource.region;
    const instanceType = str(md, ['instanceType', 'InstanceType', 'launchTemplateInstanceType']);
    const desired = num(md, ['desiredCapacity', 'DesiredCapacity']) ?? 1;
    const minSize = num(md, ['minSize', 'MinSize']);
    const maxSize = num(md, ['maxSize', 'MaxSize']);
    if (!instanceType) return null;

    const entry = catalog.getPrice(SERVICE, region, instanceType);
    const perHour = entry?.pricePerHour ?? null;
    const currentMonthly = perHour != null ? perHour * HOURS_PER_MONTH * desired : null;
    const currentConfig: ResourceConfig = {
        instanceType,
        vcpu: entry?.attributes.vcpu,
        memGiB: entry?.attributes.memGiB,
        desiredCapacity: desired,
        minSize,
        maxSize,
    };
    const t = config.asg;

    // ---- under-provisioned ----
    if (cpu.p95 > t.cpuUnderProvisionedPct) {
        const larger = entry ? pickLarger(entry, catalog.listClasses(SERVICE, region)) : null;
        const recMonthly = larger?.pricePerHour != null ? larger.pricePerHour * HOURS_PER_MONTH * desired : null;
        return {
            finding: 'under_provisioned',
            currentConfig,
            recommendedConfig: larger
                ? { instanceType: larger.resourceClass, vcpu: larger.attributes.vcpu, desiredCapacity: desired }
                : { note: 'raise max capacity' },
            riskLevel: 'high',
            rationale:
                `ASG aggregate CPU p95 ${cpu.p95.toFixed(1)}% is high. Recommend a larger instance type` +
                `${larger ? ` (${larger.resourceClass})` : ''} or raising capacity.`,
            currentMonthlyCost: currentMonthly,
            recommendedMonthlyCost: recMonthly,
        };
    }

    // ---- over-provisioned ----
    if (cpu.p95 < t.cpuOverProvisionedPct) {
        const curVcpu = entry?.attributes.vcpu ?? 0;
        const req: CapacityRequirement = {
            requiredVcpu: Math.max(1, (curVcpu * cpu.p95) / 100 * config.headroomMultiplier),
            requiredMemGiB: 0,
        };
        const smaller: CatalogEntry | null = entry ? pickSmaller(entry, catalog.listClasses(SERVICE, region), req) : null;
        if (smaller) {
            const recMonthly = smaller.pricePerHour != null ? smaller.pricePerHour * HOURS_PER_MONTH * desired : null;
            return {
                finding: 'over_provisioned',
                currentConfig,
                recommendedConfig: {
                    instanceType: smaller.resourceClass,
                    vcpu: smaller.attributes.vcpu,
                    desiredCapacity: desired,
                },
                riskLevel: 'medium',
                rationale:
                    `ASG aggregate CPU p95 ${cpu.p95.toFixed(1)}% is low across ${desired} instance(s). ` +
                    `Downsize launch-template type to ${smaller.resourceClass} (meets ${config.headroomMultiplier}× headroom).`,
                currentMonthlyCost: currentMonthly,
                recommendedMonthlyCost: recMonthly,
            };
        }
    }

    // ---- optimized ----
    return {
        finding: 'optimized',
        currentConfig,
        recommendedConfig: null,
        riskLevel: 'low',
        rationale: `ASG launch type ${instanceType} is appropriately sized (CPU p95 ${cpu.p95.toFixed(1)}%).`,
        currentMonthlyCost: currentMonthly,
        recommendedMonthlyCost: currentMonthly,
    };
}
