import { describe, it, expect } from 'vitest';
import { meetsRequirement, pickSmaller, pickLarger } from './mapping.js';
import type { CatalogEntry } from '../services/engine.js';

function entry(resourceClass: string, vcpu: number, memGiB: number, pricePerHour: number | null, family = 'm5'): CatalogEntry {
    return { region: 'us-east-1', serviceCode: 'ec2', resourceClass, pricePerHour, attributes: { vcpu, memGiB, family } };
}

describe('meetsRequirement', () => {
    it('accepts a candidate with sufficient vCPU and memory', () => {
        expect(meetsRequirement(entry('m5.large', 2, 8, 0.1), { requiredVcpu: 2, requiredMemGiB: 8 })).toBe(true);
    });

    it('rejects a candidate with too few vCPUs', () => {
        expect(meetsRequirement(entry('m5.small', 1, 2, 0.05), { requiredVcpu: 2, requiredMemGiB: 0 })).toBe(false);
    });

    it('rejects a candidate with too little memory when memory is constrained', () => {
        expect(meetsRequirement(entry('m5.large', 4, 4, 0.1), { requiredVcpu: 2, requiredMemGiB: 8 })).toBe(false);
    });

    it('ignores memory when requiredMemGiB is 0 (unconstrained)', () => {
        expect(meetsRequirement(entry('m5.large', 4, 1, 0.1), { requiredVcpu: 2, requiredMemGiB: 0 })).toBe(true);
    });
});

describe('pickSmaller', () => {
    const current = entry('m5.xlarge', 4, 16, 0.2);

    it('picks the cheapest smaller candidate in the same family that still meets the requirement', () => {
        const candidates = [
            entry('m5.large', 2, 8, 0.1),
            entry('m5.medium', 1, 4, 0.05), // too small to meet requirement
            entry('c5.large', 2, 4, 0.08, 'c5'), // different family
        ];
        const result = pickSmaller(current, candidates, { requiredVcpu: 2, requiredMemGiB: 8 });
        expect(result?.resourceClass).toBe('m5.large');
    });

    it('never recommends a candidate that fails the capacity requirement, even if cheaper', () => {
        const candidates = [entry('m5.medium', 1, 4, 0.02)];
        expect(pickSmaller(current, candidates, { requiredVcpu: 2, requiredMemGiB: 8 })).toBeNull();
    });

    it('excludes candidates from a different instance family', () => {
        const candidates = [entry('c5.large', 2, 8, 0.05, 'c5')];
        expect(pickSmaller(current, candidates, { requiredVcpu: 2, requiredMemGiB: 4 })).toBeNull();
    });

    it('excludes the current resourceClass itself', () => {
        const candidates = [entry('m5.xlarge', 4, 16, 0.2)];
        expect(pickSmaller(current, candidates, { requiredVcpu: 4, requiredMemGiB: 16 })).toBeNull();
    });

    it('falls back to vCPU comparison when price data is missing', () => {
        const noPriceCurrent = entry('m5.xlarge', 4, 16, null);
        const candidates = [entry('m5.large', 2, 8, null)];
        const result = pickSmaller(noPriceCurrent, candidates, { requiredVcpu: 2, requiredMemGiB: 0 });
        expect(result?.resourceClass).toBe('m5.large');
    });

    it('returns null when no smaller candidate exists', () => {
        expect(pickSmaller(current, [], { requiredVcpu: 2, requiredMemGiB: 8 })).toBeNull();
    });
});

describe('pickLarger', () => {
    const current = entry('m5.large', 2, 8, 0.1);

    it('picks the smallest step up (lowest price greater than current) in the same family', () => {
        const candidates = [
            entry('m5.xlarge', 4, 16, 0.2),
            entry('m5.2xlarge', 8, 32, 0.4),
            entry('c5.xlarge', 4, 8, 0.15, 'c5'), // different family
        ];
        const result = pickLarger(current, candidates);
        expect(result?.resourceClass).toBe('m5.xlarge');
    });

    it('excludes candidates that are not strictly more expensive/larger', () => {
        const candidates = [entry('m5.medium', 1, 4, 0.05)];
        expect(pickLarger(current, candidates)).toBeNull();
    });

    it('falls back to vCPU comparison when price data is missing', () => {
        const noPriceCurrent = entry('m5.large', 2, 8, null);
        const candidates = [entry('m5.xlarge', 4, 16, null)];
        const result = pickLarger(noPriceCurrent, candidates);
        expect(result?.resourceClass).toBe('m5.xlarge');
    });

    it('returns null when nothing larger exists', () => {
        expect(pickLarger(current, [])).toBeNull();
    });
});
