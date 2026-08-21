// workers/src/jobs/spot-guard/services/db-writer.test.ts
//
// Pure-function tests for the db-writer. Everything else in that module is SQL and is
// covered by db-writer.integration.test.ts against a real Postgres.
import { describe, it, expect } from 'vitest';
import { reportDateFor } from './db-writer.js';

describe('reportDateFor', () => {
    it('formats as YYYY-MM-DD in UTC', () => {
        expect(reportDateFor(new Date('2026-07-20T10:00:00Z'), 'UTC')).toBe('2026-07-20');
    });

    it('rolls to the next day for a late-UTC instant in a positive-offset zone', () => {
        // 23:30 UTC on the 20th is 05:00 on the 21st in IST (+05:30). The reference
        // implementation filed sessions under the task's createdAt date, which put
        // cross-midnight tasks on the wrong day entirely.
        expect(reportDateFor(new Date('2026-07-20T23:30:00Z'), 'Asia/Kolkata')).toBe('2026-07-21');
    });

    it('rolls to the previous day for an early-UTC instant in a negative-offset zone', () => {
        // 02:00 UTC on the 21st is 22:00 on the 20th in New York (-04:00 in July).
        expect(reportDateFor(new Date('2026-07-21T02:00:00Z'), 'America/New_York')).toBe('2026-07-20');
    });

    it('handles a half-hour offset zone correctly at the boundary', () => {
        // 18:29 UTC is 23:59 IST on the same day; 18:30 UTC is 00:00 the next.
        expect(reportDateFor(new Date('2026-07-20T18:29:00Z'), 'Asia/Kolkata')).toBe('2026-07-20');
        expect(reportDateFor(new Date('2026-07-20T18:30:00Z'), 'Asia/Kolkata')).toBe('2026-07-21');
    });

    it('respects DST — the same wall time maps differently in summer and winter', () => {
        // New York is -04:00 in July and -05:00 in January. 03:30 UTC therefore lands on
        // the previous day in winter but not in summer.
        expect(reportDateFor(new Date('2026-07-21T03:30:00Z'), 'America/New_York')).toBe('2026-07-20');
        expect(reportDateFor(new Date('2026-01-21T03:30:00Z'), 'America/New_York')).toBe('2026-01-20');
        expect(reportDateFor(new Date('2026-01-21T05:30:00Z'), 'America/New_York')).toBe('2026-01-21');
    });

    it('zero-pads single-digit months and days', () => {
        expect(reportDateFor(new Date('2026-01-05T12:00:00Z'), 'UTC')).toBe('2026-01-05');
    });

    it('falls back to UTC on an invalid timezone instead of throwing', () => {
        // A bad tenant config must not fail the session write — the label degrades while
        // the session data, which is what the report actually clips over, is preserved.
        expect(reportDateFor(new Date('2026-07-20T10:00:00Z'), 'Not/AZone')).toBe('2026-07-20');
    });

    it('crosses a year boundary correctly', () => {
        expect(reportDateFor(new Date('2026-12-31T20:00:00Z'), 'Asia/Kolkata')).toBe('2027-01-01');
    });
});
