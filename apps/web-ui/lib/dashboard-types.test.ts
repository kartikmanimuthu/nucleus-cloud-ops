import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    getTimeRangeDate, getTimeBucketFormat, bucketTimestamp, computeDelta, getPreviousPeriodDate,
} from './dashboard-types';

afterEach(() => vi.useRealTimers());

describe('getTimeRangeDate', () => {
    it('computes the correct cutoff for each range', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-02-10T00:00:00Z'));

        expect(getTimeRangeDate('24h')).toEqual(new Date('2026-02-09T00:00:00Z'));
        expect(getTimeRangeDate('7d')).toEqual(new Date('2026-02-03T00:00:00Z'));
        expect(getTimeRangeDate('30d')).toEqual(new Date('2026-01-11T00:00:00Z'));
        expect(getTimeRangeDate('90d')).toEqual(new Date('2025-11-12T00:00:00Z'));
    });
});

describe('getTimeBucketFormat', () => {
    it('returns hourly buckets for 24h', () => {
        expect(getTimeBucketFormat('24h')).toEqual({ bucketMs: 60 * 60 * 1000, format: 'HH:00' });
    });

    it('returns daily buckets for 7d and 30d', () => {
        expect(getTimeBucketFormat('7d').bucketMs).toBe(24 * 60 * 60 * 1000);
        expect(getTimeBucketFormat('30d').bucketMs).toBe(24 * 60 * 60 * 1000);
    });

    it('returns weekly buckets for 90d', () => {
        expect(getTimeBucketFormat('90d').bucketMs).toBe(7 * 24 * 60 * 60 * 1000);
    });
});

describe('bucketTimestamp', () => {
    it('buckets by hour for 24h', () => {
        expect(bucketTimestamp(new Date('2026-02-10T15:42:00'), '24h')).toBe('2026-02-10T15:00');
    });

    it('buckets by day for 7d/30d', () => {
        expect(bucketTimestamp(new Date('2026-02-10T15:42:00'), '7d')).toBe('2026-02-10');
        expect(bucketTimestamp(new Date('2026-02-10T15:42:00'), '30d')).toBe('2026-02-10');
    });

    it('buckets by week (start-of-week) for 90d', () => {
        // 2026-02-10 is a Tuesday; the week start is Sunday 2026-02-08.
        expect(bucketTimestamp(new Date('2026-02-10T15:42:00'), '90d')).toBe('2026-02-08');
    });
});

describe('computeDelta', () => {
    it('returns neutral with zero delta when the previous value is zero', () => {
        expect(computeDelta(50, 0)).toEqual({ delta: 0, deltaDirection: 'neutral' });
    });

    it('reports an "up" direction with the absolute percentage change on an increase', () => {
        expect(computeDelta(150, 100)).toEqual({ delta: 50, deltaDirection: 'up' });
    });

    it('reports a "down" direction with the absolute percentage change on a decrease', () => {
        expect(computeDelta(50, 100)).toEqual({ delta: 50, deltaDirection: 'down' });
    });

    it('reports neutral when the value is unchanged', () => {
        expect(computeDelta(100, 100)).toEqual({ delta: 0, deltaDirection: 'neutral' });
    });
});

describe('getPreviousPeriodDate', () => {
    it('returns a window immediately preceding the current range, of equal duration', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-02-10T00:00:00Z'));

        const { start, end } = getPreviousPeriodDate('7d');
        expect(end).toEqual(new Date('2026-02-03T00:00:00Z'));
        expect(end.getTime() - start.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
    });
});
