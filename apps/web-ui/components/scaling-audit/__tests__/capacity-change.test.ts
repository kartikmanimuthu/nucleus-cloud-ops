import { describe, it, expect } from 'vitest';
import { formatCapacityChange, capacityChangeHint } from '../shared';

describe('formatCapacityChange', () => {
    it('renders a full before → after when both are known (activity-API rows)', () => {
        expect(formatCapacityChange(2, 1)).toBe('2 → 1');
        expect(formatCapacityChange(0, 1)).toBe('0 → 1');
    });

    it('omits the prior value rather than printing "?" when it is unavailable', () => {
        // CloudTrail reports only the requested count. "? → 1" read like data we
        // lost or failed to parse; "→ 1" states what actually happened.
        expect(formatCapacityChange(null, 1)).toBe('→ 1');
        expect(formatCapacityChange(undefined, 3)).toBe('→ 3');
    });

    it('keeps zero distinct from unknown', () => {
        // 0 is falsy — a truthiness check here would render a real scale-to-zero
        // as if the prior value were missing.
        expect(formatCapacityChange(0, 2)).toBe('0 → 2');
        expect(formatCapacityChange(2, 0)).toBe('2 → 0');
    });

    it('shows an em dash when nothing is known', () => {
        expect(formatCapacityChange(null, null)).toBe('—');
    });

    it('marks an unknown target explicitly, since that IS unexpected', () => {
        expect(formatCapacityChange(2, null)).toBe('2 → ?');
    });
});

describe('capacityChangeHint', () => {
    it('explains the bare arrow only when the prior value is missing', () => {
        expect(capacityChangeHint(null, 1)).toContain('Prior capacity is not reported');
    });

    it('adds no hint when both values are present', () => {
        expect(capacityChangeHint(2, 1)).toBeUndefined();
    });

    it('adds no hint when there is nothing to show at all', () => {
        expect(capacityChangeHint(null, null)).toBeUndefined();
    });
});
