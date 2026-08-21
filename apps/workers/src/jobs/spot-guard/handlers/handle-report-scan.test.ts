// workers/src/jobs/spot-guard/handlers/handle-report-scan.test.ts
//
// Tests for dayWindow, the one piece of the report handler that is pure and easy to get
// wrong: "the 20th in Asia/Kolkata" is NOT midnight-to-midnight UTC, and getting it wrong
// shifts every daily figure by the zone offset.
import { describe, it, expect } from 'vitest';
import { dayWindow } from './handle-report-scan.js';

describe('dayWindow', () => {
    it('spans exactly 24 hours', () => {
        const { from, to } = dayWindow('2026-07-20', 'UTC');
        expect(to.getTime() - from.getTime()).toBe(86_400_000);
    });

    it('is midnight-to-midnight for UTC', () => {
        const { from, to } = dayWindow('2026-07-20', 'UTC');
        expect(from.toISOString()).toBe('2026-07-20T00:00:00.000Z');
        expect(to.toISOString()).toBe('2026-07-21T00:00:00.000Z');
    });

    it('shifts back by the offset for a positive-offset zone', () => {
        // The 20th in IST (+05:30) begins at 18:30 UTC on the 19th. Using UTC midnight
        // instead would attribute 5.5 hours of the previous IST day to this report.
        const { from, to } = dayWindow('2026-07-20', 'Asia/Kolkata');
        expect(from.toISOString()).toBe('2026-07-19T18:30:00.000Z');
        expect(to.toISOString()).toBe('2026-07-20T18:30:00.000Z');
    });

    it('shifts forward by the offset for a negative-offset zone', () => {
        // The 20th in New York (-04:00 in July) begins at 04:00 UTC on the 20th.
        const { from } = dayWindow('2026-07-20', 'America/New_York');
        expect(from.toISOString()).toBe('2026-07-20T04:00:00.000Z');
    });

    it('accounts for DST — the same date has a different offset in winter', () => {
        // New York is -04:00 in July and -05:00 in January. A fixed offset would be an hour
        // out for half the year.
        expect(dayWindow('2026-01-20', 'America/New_York').from.toISOString()).toBe('2026-01-20T05:00:00.000Z');
    });

    it('produces adjacent, non-overlapping windows for consecutive days', () => {
        // Required for the midnight-split property to hold: a task spanning the boundary
        // must be counted once on each side, with no gap and no double count.
        const d20 = dayWindow('2026-07-20', 'Asia/Kolkata');
        const d21 = dayWindow('2026-07-21', 'Asia/Kolkata');
        expect(d20.to.toISOString()).toBe(d21.from.toISOString());
    });

    it('handles a month boundary', () => {
        const { from, to } = dayWindow('2026-07-31', 'UTC');
        expect(from.toISOString()).toBe('2026-07-31T00:00:00.000Z');
        expect(to.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    });
});
