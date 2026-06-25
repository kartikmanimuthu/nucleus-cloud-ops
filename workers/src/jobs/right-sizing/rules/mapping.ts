// workers/src/jobs/right-sizing/rules/mapping.ts
//
// Instance/class mapping helpers shared by the EC2, RDS, and ASG rules (RS-011/012/014).
// Pure functions over CatalogEntry lists. Never recommend a target with less capacity
// than the required headroom — this is the core safety invariant.
import type { CatalogEntry } from '../services/engine.js';

export interface CapacityRequirement {
    /** Minimum vCPUs the target must provide. */
    requiredVcpu: number;
    /** Minimum memory (GiB) the target must provide; 0 = unconstrained (memory unknown). */
    requiredMemGiB: number;
}

function vcpu(e: CatalogEntry): number {
    return typeof e.attributes.vcpu === 'number' ? e.attributes.vcpu : 0;
}
function mem(e: CatalogEntry): number {
    return typeof e.attributes.memGiB === 'number' ? e.attributes.memGiB : 0;
}
function family(e: CatalogEntry): string | undefined {
    return typeof e.attributes.family === 'string' ? e.attributes.family : undefined;
}

/** Does a candidate satisfy the capacity requirement? */
export function meetsRequirement(candidate: CatalogEntry, req: CapacityRequirement): boolean {
    if (vcpu(candidate) < req.requiredVcpu) return false;
    if (req.requiredMemGiB > 0 && mem(candidate) < req.requiredMemGiB) return false;
    return true;
}

/**
 * Pick the cheapest smaller instance in the SAME family that still meets the requirement.
 * Returns null if no strictly-smaller, cheaper, sufficient candidate exists.
 */
export function pickSmaller(
    current: CatalogEntry,
    candidates: CatalogEntry[],
    req: CapacityRequirement
): CatalogEntry | null {
    const curPrice = current.pricePerHour ?? null;
    const curVcpu = vcpu(current);
    const fam = family(current);

    const viable = candidates.filter((c) => {
        if (c.resourceClass === current.resourceClass) return false;
        if (fam && family(c) && family(c) !== fam) return false;
        if (!meetsRequirement(c, req)) return false;
        // Must be genuinely smaller/cheaper than current.
        if (curPrice != null && c.pricePerHour != null) return c.pricePerHour < curPrice;
        return vcpu(c) < curVcpu;
    });
    if (!viable.length) return null;

    // Cheapest (or fewest vCPUs when prices missing) wins — maximizes savings while safe.
    viable.sort((a, b) => {
        const pa = a.pricePerHour ?? Number.MAX_VALUE;
        const pb = b.pricePerHour ?? Number.MAX_VALUE;
        if (pa !== pb) return pa - pb;
        return vcpu(a) - vcpu(b);
    });
    return viable[0];
}

/**
 * Pick the next size up in the SAME family (smallest step that adds capacity).
 * Returns null if nothing larger exists.
 */
export function pickLarger(current: CatalogEntry, candidates: CatalogEntry[]): CatalogEntry | null {
    const curPrice = current.pricePerHour ?? null;
    const curVcpu = vcpu(current);
    const fam = family(current);

    const viable = candidates.filter((c) => {
        if (c.resourceClass === current.resourceClass) return false;
        if (fam && family(c) && family(c) !== fam) return false;
        if (curPrice != null && c.pricePerHour != null) return c.pricePerHour > curPrice;
        return vcpu(c) > curVcpu;
    });
    if (!viable.length) return null;

    // Smallest step up: lowest price greater than current (or fewest extra vCPUs).
    viable.sort((a, b) => {
        const pa = a.pricePerHour ?? Number.MAX_VALUE;
        const pb = b.pricePerHour ?? Number.MAX_VALUE;
        if (pa !== pb) return pa - pb;
        return vcpu(a) - vcpu(b);
    });
    return viable[0];
}
