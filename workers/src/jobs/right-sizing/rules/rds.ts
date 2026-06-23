// workers/src/jobs/right-sizing/rules/rds.ts
//
// RDS instance right-sizing rule (RS-012). Pure.
// Uses CPU, freeable memory, connections to classify and map to a smaller/larger DB class.
import { HOURS_PER_MONTH } from '../config.js';
import type { RuleContext, RuleOutput, CatalogEntry } from '../services/engine.js';
import type { ResourceConfig } from '../types.js';
import { pickSmaller, pickLarger, type CapacityRequirement } from './mapping.js';

const SERVICE = 'AmazonRDS';
const GIB = 1024 * 1024 * 1024;

function getStr(md: Record<string, unknown>, keys: string[]): string | undefined {
    for (const k of keys) {
        const v = md[k];
        if (typeof v === 'string' && v) return v;
    }
    return undefined;
}
function monthly(e: CatalogEntry | null): number | null {
    return e && e.pricePerHour != null ? e.pricePerHour * HOURS_PER_MONTH : null;
}
function cfg(cls: string, e: CatalogEntry | null): ResourceConfig {
    return { dbInstanceClass: cls, vcpu: e?.attributes.vcpu, memGiB: e?.attributes.memGiB };
}

export function evaluateRds(ctx: RuleContext): RuleOutput | null {
    const { resource, summary, config, catalog } = ctx;
    const cpu = summary.cpu;
    if (!cpu) return null;

    const region = resource.region;
    const dbClass = getStr(resource.metadata, ['dbInstanceClass', 'DBInstanceClass', 'instanceClass']);
    if (!dbClass) return null;

    const entry = catalog.getPrice(SERVICE, region, dbClass);
    const currentConfig = cfg(dbClass, entry);
    const currentMonthly = monthly(entry);
    const t = config.rds;
    const curMemGiB = entry?.attributes.memGiB ?? 0;
    const conns = summary.connections;
    const freeable = summary.freeableMemory; // bytes

    const freeFraction = freeable && curMemGiB ? freeable.avg / (curMemGiB * GIB) : null;

    // ---- idle ----
    if ((conns ? conns.p95 < 1 : false) && cpu.p95 < t.cpuIdlePct) {
        return {
            finding: 'idle',
            currentConfig,
            recommendedConfig: { action: 'stop_or_remove' },
            riskLevel: 'medium',
            rationale:
                `DB ${dbClass} is idle: ~0 connections and CPU p95 ${cpu.p95.toFixed(1)}% over ` +
                `${summary.coverageDays.toFixed(1)}d. Review whether it can be stopped or removed.`,
            currentMonthlyCost: currentMonthly,
            recommendedMonthlyCost: 0,
            savingsIsFullCurrent: true,
        };
    }

    const memUnder = freeFraction != null ? freeFraction < 0.1 : false; // < 10% free
    const memOver = freeFraction != null ? freeFraction > 0.5 : true; // > 50% free (or unknown)

    // ---- under-provisioned ----
    if (cpu.p95 > t.cpuUnderProvisionedPct || memUnder) {
        const larger = entry ? pickLarger(entry, catalog.listClasses(SERVICE, region)) : null;
        return {
            finding: 'under_provisioned',
            currentConfig,
            recommendedConfig: larger ? cfg(larger.resourceClass, larger) : null,
            riskLevel: 'high',
            rationale:
                `DB ${dbClass} is under-provisioned: CPU p95 ${cpu.p95.toFixed(1)}%` +
                `${freeFraction != null ? `, ${(freeFraction * 100).toFixed(0)}% memory free` : ''}. ` +
                `Recommend scaling up${larger ? ` to ${larger.resourceClass}` : ''}.`,
            currentMonthlyCost: currentMonthly,
            recommendedMonthlyCost: monthly(larger),
        };
    }

    // ---- over-provisioned ----
    if (cpu.p95 < t.cpuOverProvisionedPct && memOver) {
        const usedMemGiB = freeable && curMemGiB ? Math.max(0, curMemGiB - freeable.avg / GIB) : 0;
        const req: CapacityRequirement = {
            requiredVcpu: Math.max(1, ((entry?.attributes.vcpu ?? 0) * cpu.p95) / 100 * config.headroomMultiplier),
            requiredMemGiB: usedMemGiB > 0 ? usedMemGiB * config.headroomMultiplier : 0,
        };
        const smaller = entry ? pickSmaller(entry, catalog.listClasses(SERVICE, region), req) : null;
        if (smaller) {
            return {
                finding: 'over_provisioned',
                currentConfig,
                recommendedConfig: cfg(smaller.resourceClass, smaller),
                riskLevel: 'medium',
                rationale:
                    `DB ${dbClass} is over-provisioned: CPU p95 ${cpu.p95.toFixed(1)}%` +
                    `${freeFraction != null ? `, ${(freeFraction * 100).toFixed(0)}% memory free` : ''}. ` +
                    `Downsize to ${smaller.resourceClass} (meets ${config.headroomMultiplier}× headroom).`,
                currentMonthlyCost: currentMonthly,
                recommendedMonthlyCost: monthly(smaller),
            };
        }
    }

    // ---- optimized ----
    return {
        finding: 'optimized',
        currentConfig,
        recommendedConfig: null,
        riskLevel: 'low',
        rationale: `DB ${dbClass} is appropriately sized (CPU p95 ${cpu.p95.toFixed(1)}%).`,
        currentMonthlyCost: currentMonthly,
        recommendedMonthlyCost: currentMonthly,
    };
}
