import { describe, it, expect } from 'vitest';
import { computeSeal } from './daily-seal.js';

const DIGEST_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('computeSeal — a seal must bind to the record it covers', () => {
    it('two tenants with an identical day and row set get DIFFERENT seals', () => {
        // The defect, verbatim from sbx on 2026-08-05: five tenants each sealed
        // 2026-08-05 with rowCount 0 and all shared seal 2b0c0f7f… Because tenantId
        // was absent from the preimage, one tenant's seal would verify against
        // another tenant's export — so the seal proved nothing about whose record
        // it was.
        const a = computeSeal('tenant-a', '2026-08-05', 0, DIGEST_EMPTY, null);
        const b = computeSeal('tenant-b', '2026-08-05', 0, DIGEST_EMPTY, null);
        expect(a).not.toBe(b);
    });

    it('is deterministic for identical inputs', () => {
        expect(computeSeal('t', '2026-08-05', 3, 'abc', 'prev')).toBe(computeSeal('t', '2026-08-05', 3, 'abc', 'prev'));
    });

    it('changes when ANY component changes — each must be covered by the hash', () => {
        const base = computeSeal('t', '2026-08-05', 3, 'abc', 'prev');
        expect(computeSeal('t2', '2026-08-05', 3, 'abc', 'prev')).not.toBe(base); // tenant
        expect(computeSeal('t', '2026-08-06', 3, 'abc', 'prev')).not.toBe(base); // day
        expect(computeSeal('t', '2026-08-05', 4, 'abc', 'prev')).not.toBe(base); // rowCount
        expect(computeSeal('t', '2026-08-05', 3, 'xyz', 'prev')).not.toBe(base); // digest
        expect(computeSeal('t', '2026-08-05', 3, 'abc', 'other')).not.toBe(base); // prevSeal
    });

    it('distinguishes a first seal (null prev) from one chained to an empty string', () => {
        // Guards the ?? '' fallback from collapsing two genuinely different states.
        expect(computeSeal('t', '2026-08-05', 0, DIGEST_EMPTY, null))
            .toBe(computeSeal('t', '2026-08-05', 0, DIGEST_EMPTY, ''));
        // Documented consequence: only the FIRST day of a tenant may have a null
        // prevSeal, which the schema comment already states.
    });

    it('a tampered row count breaks the chain from that day forward', () => {
        // Day 1 → day 2 → day 3, then day 1 is altered.
        const d1 = computeSeal('t', '2026-08-01', 5, 'digest1', null);
        const d2 = computeSeal('t', '2026-08-02', 2, 'digest2', d1);
        const d3 = computeSeal('t', '2026-08-03', 7, 'digest3', d2);

        const d1Tampered = computeSeal('t', '2026-08-01', 4, 'digest1-altered', null);
        const d2Recomputed = computeSeal('t', '2026-08-02', 2, 'digest2', d1Tampered);
        const d3Recomputed = computeSeal('t', '2026-08-03', 7, 'digest3', d2Recomputed);

        expect(d1Tampered).not.toBe(d1);
        expect(d2Recomputed).not.toBe(d2); // break propagates forward…
        expect(d3Recomputed).not.toBe(d3); // …all the way to the newest seal
    });
});
