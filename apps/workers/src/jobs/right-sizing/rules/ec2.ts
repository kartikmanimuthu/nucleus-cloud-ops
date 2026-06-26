// workers/src/jobs/right-sizing/rules/ec2.ts
//
// EC2 instance right-sizing rule (RS-011). Pure.
// Classifies idle / over / under / optimized from CPU + (optional) memory + network,
// and maps an over/under-provisioned instance to a target type via the catalog.
import { HOURS_PER_MONTH } from '../config.js';
import type { RuleContext, RuleOutput, CatalogEntry } from '../services/engine.js';
import type { ResourceConfig } from '../types.js';
import { pickSmaller, pickLarger, type CapacityRequirement } from './mapping.js';

const SERVICE = 'AmazonEC2';

function getStr(md: Record<string, unknown>, keys: string[]): string | undefined {
    for (const k of keys) {
        const v = md[k];
        if (typeof v === 'string' && v) return v;
    }
    return undefined;
}

function monthlyFromEntry(e: CatalogEntry | null): number | null {
    if (!e || e.pricePerHour == null) return null;
    return e.pricePerHour * HOURS_PER_MONTH;
}

function configFromEntry(type: string, e: CatalogEntry | null): ResourceConfig {
    return { instanceType: type, vcpu: e?.attributes.vcpu, memGiB: e?.attributes.memGiB };
}

export function evaluateEc2(ctx: RuleContext): RuleOutput | null {
    const { resource, summary, config, catalog } = ctx;
    const cpu = summary.cpu;
    if (!cpu) return null; // no CPU data → can't classify

    const region = resource.region;
    const instanceType = getStr(resource.metadata, ['instanceType', 'InstanceType']);
    if (!instanceType) return null;

    const currentEntry = catalog.getPrice(SERVICE, region, instanceType);
    const currentConfig = configFromEntry(instanceType, currentEntry);
    const currentMonthly = monthlyFromEntry(currentEntry);
    const t = config.ec2;
    const mem = summary.memory; // CWAgent %, may be null
    const netP95 = (summary.networkIn?.p95 ?? 0) + (summary.networkOut?.p95 ?? 0);
    const memNote = mem ? '' : ' Memory metric unavailable (no CloudWatch agent) — decision based on CPU only.';

    // ---- idle ----
    if (cpu.p95 < t.cpuIdlePct && netP95 < config.idleNetworkBytesP95) {
        return {
            finding: 'idle',
            currentConfig,
            recommendedConfig: { action: 'stop_or_terminate' },
            riskLevel: 'medium',
            rationale:
                `Instance ${instanceType} is idle: CPU p95 ${cpu.p95.toFixed(1)}% and negligible network over ` +
                `${summary.coverageDays.toFixed(1)}d. Consider stopping or terminating.${memNote}`,
            currentMonthlyCost: currentMonthly,
            recommendedMonthlyCost: 0,
            savingsIsFullCurrent: true,
        };
    }

    const memOver = mem ? mem.p95 < t.memOverProvisionedPct : true;
    const memUnder = mem ? mem.p95 > t.memUnderProvisionedPct : false;

    // ---- under-provisioned ----
    if (cpu.p95 > t.cpuUnderProvisionedPct || memUnder) {
        const list = catalog.listClasses(SERVICE, region);
        const larger = currentEntry ? pickLarger(currentEntry, list) : null;
        const recMonthly = monthlyFromEntry(larger);
        return {
            finding: 'under_provisioned',
            currentConfig,
            recommendedConfig: larger ? configFromEntry(larger.resourceClass, larger) : null,
            riskLevel: 'high',
            rationale:
                `Instance ${instanceType} is under-provisioned: CPU p95 ${cpu.p95.toFixed(1)}%` +
                `${mem ? `, memory p95 ${mem.p95.toFixed(1)}%` : ''}. Recommend scaling up` +
                `${larger ? ` to ${larger.resourceClass}` : ''}.${memNote}`,
            currentMonthlyCost: currentMonthly,
            recommendedMonthlyCost: recMonthly,
        };
    }

    // ---- over-provisioned ----
    if (cpu.p95 < t.cpuOverProvisionedPct && memOver) {
        const curVcpu = currentEntry?.attributes.vcpu ?? 0;
        const curMem = currentEntry?.attributes.memGiB ?? 0;
        const req: CapacityRequirement = {
            requiredVcpu: Math.max(1, (curVcpu * cpu.p95) / 100 * config.headroomMultiplier),
            requiredMemGiB: mem && curMem ? (curMem * mem.p95) / 100 * config.headroomMultiplier : 0,
        };
        const list = catalog.listClasses(SERVICE, region);
        const smaller = currentEntry ? pickSmaller(currentEntry, list, req) : null;
        if (smaller) {
            return {
                finding: 'over_provisioned',
                currentConfig,
                recommendedConfig: configFromEntry(smaller.resourceClass, smaller),
                riskLevel: 'medium',
                rationale:
                    `Instance ${instanceType} is over-provisioned: CPU p95 ${cpu.p95.toFixed(1)}%` +
                    `${mem ? `, memory p95 ${mem.p95.toFixed(1)}%` : ''}. Downsize to ${smaller.resourceClass} ` +
                    `(meets ${config.headroomMultiplier}× headroom).${memNote}`,
                currentMonthlyCost: currentMonthly,
                recommendedMonthlyCost: monthlyFromEntry(smaller),
            };
        }
        // Over-provisioned but no cheaper same-family candidate (already smallest, or catalog gap).
    }

    // ---- optimized ----
    return {
        finding: 'optimized',
        currentConfig,
        recommendedConfig: null,
        riskLevel: 'low',
        rationale: `Instance ${instanceType} is appropriately sized (CPU p95 ${cpu.p95.toFixed(1)}%).${memNote}`,
        currentMonthlyCost: currentMonthly,
        recommendedMonthlyCost: currentMonthly,
    };
}
