import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatDate, formatTime, formatDateTime, getRelativeTime } from '@/lib/date-utils';

describe('formatDate', () => {
    it('returns "N/A" for null or undefined input', () => {
        expect(formatDate(null)).toBe('N/A');
        expect(formatDate(undefined)).toBe('N/A');
    });

    it('returns "Invalid Date" for an unparsable string', () => {
        expect(formatDate('not-a-date')).toBe('Invalid Date');
    });

    it('accepts a Date object directly', () => {
        expect(formatDate(new Date('2025-01-15T14:30:45Z'), 'shortDate')).toBe('Jan 15, 2025 UTC');
    });

    it('accepts a numeric timestamp', () => {
        expect(formatDate(new Date('2025-01-15T14:30:45Z').getTime(), 'shortDate')).toBe('Jan 15, 2025 UTC');
    });

    it('defaults to UTC with an explicit "UTC" suffix when no timezone is given', () => {
        expect(formatDate('2025-01-15T14:30:45Z', 'timeOnly')).toBe('14:30 UTC');
    });

    it('formats in the given IANA timezone without a UTC suffix', () => {
        expect(formatDate('2025-01-15T14:30:45Z', 'timeOnly', 'Asia/Kolkata')).toBe('20:00');
    });

    it('applies each named preset correctly', () => {
        const iso = '2025-01-15T14:30:45Z';
        expect(formatDate(iso, 'shortDate')).toBe('Jan 15, 2025 UTC');
        expect(formatDate(iso, 'longDate')).toBe('January 15, 2025 UTC');
        expect(formatDate(iso, 'shortDateTime')).toBe('Jan 15, 2025 14:30 UTC');
        expect(formatDate(iso, 'longDateTime')).toBe('Jan 15, 2025 14:30:45 UTC');
        expect(formatDate(iso, 'timeWithSeconds')).toBe('14:30:45 UTC');
    });
});

describe('formatTime', () => {
    it('formats only the time-with-seconds portion', () => {
        expect(formatTime('2025-01-15T14:30:45Z')).toBe('14:30:45 UTC');
    });

    it('returns "N/A" for null input', () => {
        expect(formatTime(null)).toBe('N/A');
    });
});

describe('formatDateTime', () => {
    it('is an alias for formatDate with the same preset behavior', () => {
        expect(formatDateTime('2025-01-15T14:30:45Z', 'shortDate')).toBe(formatDate('2025-01-15T14:30:45Z', 'shortDate'));
    });

    it('defaults to the shortDate preset when none is given', () => {
        expect(formatDateTime('2025-01-15T14:30:45Z')).toBe('Jan 15, 2025 UTC');
    });
});

describe('getRelativeTime', () => {
    afterEach(() => vi.useRealTimers());

    it('returns "Invalid Date" for an unparsable string', () => {
        expect(getRelativeTime('not-a-date')).toBe('Invalid Date');
    });

    it('returns "Just now" for under a minute ago', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2025-01-15T14:30:45Z'));
        expect(getRelativeTime(new Date('2025-01-15T14:30:20Z'))).toBe('Just now');
    });

    it('returns minutes-ago for under an hour', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2025-01-15T14:30:00Z'));
        expect(getRelativeTime(new Date('2025-01-15T14:15:00Z'))).toBe('15m ago');
    });

    it('returns hours-ago for under a day', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2025-01-15T14:30:00Z'));
        expect(getRelativeTime(new Date('2025-01-15T10:30:00Z'))).toBe('4h ago');
    });

    it('returns days-ago for under a week', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2025-01-15T14:30:00Z'));
        expect(getRelativeTime(new Date('2025-01-12T14:30:00Z'))).toBe('3d ago');
    });

    it('falls back to the shortDate format for a week or older', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2025-01-15T14:30:00Z'));
        expect(getRelativeTime(new Date('2025-01-01T14:30:00Z'))).toBe('Jan 01, 2025 UTC');
    });

    it('accepts a numeric timestamp input', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2025-01-15T14:30:00Z'));
        expect(getRelativeTime(new Date('2025-01-15T14:15:00Z').getTime())).toBe('15m ago');
    });
});
