import { describe, it, expect } from 'vitest';
import { istDayStart, istDayEndExclusive, istDayRangeFilter } from './ist-date-range';

describe('istDayStart', () => {
    it('returns the UTC instant of IST midnight, not UTC midnight', () => {
        // IST midnight (00:00 +05:30) on 2026-08-15 is 18:30 UTC on 2026-08-14.
        const d = istDayStart('2026-08-15');
        expect(d.toISOString()).toBe('2026-08-14T18:30:00.000Z');
    });
});

describe('istDayEndExclusive', () => {
    it('returns the start of the NEXT IST day (exclusive upper bound)', () => {
        const d = istDayEndExclusive('2026-08-15');
        expect(d.toISOString()).toBe('2026-08-15T18:30:00.000Z');
    });
});

describe('istDayRangeFilter', () => {
    it('returns undefined when neither bound is given', () => {
        expect(istDayRangeFilter(undefined, undefined)).toBeUndefined();
    });

    it('produces gte at IST-midnight of dateFrom, not naive UTC midnight', () => {
        const filter = istDayRangeFilter('2026-08-01', undefined);
        expect(filter?.gte?.toISOString()).toBe('2026-07-31T18:30:00.000Z');
        expect(filter?.lt).toBeUndefined();
    });

    it('produces an EXCLUSIVE lt at the start of the day AFTER dateTo, so the whole of dateTo counts', () => {
        // The bug this guards against: `new Date('2026-08-15')` (raw UTC midnight)
        // as an inclusive upper bound would exclude everything on 2026-08-15
        // after 05:30 IST — nearly the entire day, for an India-based product.
        const filter = istDayRangeFilter(undefined, '2026-08-15');
        expect(filter?.lt?.toISOString()).toBe('2026-08-15T18:30:00.000Z');
        // A timestamp late on 2026-08-15 IST must fall inside the range.
        const lateOnDateTo = new Date('2026-08-15T17:00:00.000Z'); // 22:30 IST
        expect(lateOnDateTo.getTime() < (filter!.lt as Date).getTime()).toBe(true);
    });

    it('produces both bounds together for a full range', () => {
        const filter = istDayRangeFilter('2026-08-01', '2026-08-15');
        expect(filter?.gte?.toISOString()).toBe('2026-07-31T18:30:00.000Z');
        expect(filter?.lt?.toISOString()).toBe('2026-08-15T18:30:00.000Z');
    });
});
