import { describe, it, expect } from 'vitest';
import { percentile, summarize } from './metric-summarizer.js';

describe('percentile', () => {
    it('returns 0 for empty series', () => {
        expect(percentile([], 0.95)).toBe(0);
    });

    it('computes nearest-rank percentiles', () => {
        const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        expect(percentile(v, 0.95)).toBe(10);
        expect(percentile(v, 0.5)).toBe(5);
        expect(percentile(v, 0.99)).toBe(10);
    });

    it('is order-independent', () => {
        expect(percentile([5, 1, 3, 2, 4], 0.95)).toBe(5);
    });
});

describe('summarize', () => {
    const opts = { lookbackDays: 14, periodSeconds: 3600 };

    it('returns null signals and zero coverage for empty input', () => {
        const s = summarize({}, opts);
        expect(s.cpu).toBeNull();
        expect(s.coverageDays).toBe(0);
        expect(s.datapointDensity).toBe(0);
    });

    it('summarizes a cpu series with avg/p95/max/count', () => {
        const cpu = Array.from({ length: 24 }, (_, i) => i + 1); // 1..24
        const s = summarize({ cpu }, opts);
        expect(s.cpu).not.toBeNull();
        expect(s.cpu!.count).toBe(24);
        expect(s.cpu!.max).toBe(24);
        expect(s.cpu!.avg).toBeCloseTo(12.5, 5);
        // nearest-rank: ceil(0.95*24)=23 → index 22 → value 23
        expect(s.cpu!.p95).toBe(23);
    });

    it('computes coverage and density from datapoint count', () => {
        // 7 days of hourly datapoints = 168 points; expected over 14d = 336.
        const cpu = Array.from({ length: 168 }, () => 10);
        const s = summarize({ cpu }, opts);
        expect(s.coverageDays).toBeCloseTo(7, 5);
        expect(s.datapointDensity).toBeCloseTo(0.5, 2);
    });

    it('caps density at 1 and coverage at lookbackDays', () => {
        const cpu = Array.from({ length: 1000 }, () => 10);
        const s = summarize({ cpu }, opts);
        expect(s.datapointDensity).toBe(1);
        expect(s.coverageDays).toBe(14);
    });
});
