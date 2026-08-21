// The filter toolbar has two rules that are easy to get subtly wrong, and both are invisible
// until someone is confused by the UI:
//
//  1. The capacity segmented control cannot represent 'mixed' or 'unknown'. If those fall through
//     to the ToggleGroup it would highlight nothing — or, worse, if mapped to "all" it would claim
//     no capacity filter is applied while the table is filtered.
//  2. The badge on "More filters" must count exactly the active filters that are NOT already
//     visible. Counting capacity unconditionally reports one filter in two places; never counting
//     it hides 'mixed'/'unknown' entirely, since no segment lights up for them either.
import { describe, it, expect } from 'vitest';
import {
    CAPACITY_SEGMENTS,
    NO_FILTERS,
    activeCapacitySegment,
    anyFilterActive,
    hiddenFilterCount,
    isSegmentedCapacity,
} from '../filter-state';

describe('CAPACITY_SEGMENTS', () => {
    it('is exactly All / On spot / On-demand', () => {
        expect(CAPACITY_SEGMENTS.map(([v]) => v)).toEqual(['all', 'spot', 'on_demand']);
    });
});

describe('activeCapacitySegment', () => {
    it.each(['all', 'spot', 'on_demand'])('passes through the representable value %s', (v) => {
        expect(activeCapacitySegment(v)).toBe(v);
    });

    it.each(['mixed', 'unknown'])('returns "" for %s so no segment falsely lights up', (v) => {
        expect(activeCapacitySegment(v)).toBe('');
        expect(isSegmentedCapacity(v)).toBe(false);
    });

    it('never maps an active filter to "all"', () => {
        // Mapping 'mixed' to 'all' would show an unfiltered control over a filtered table.
        expect(activeCapacitySegment('mixed')).not.toBe('all');
    });
});

describe('anyFilterActive', () => {
    it('is false when everything is unset', () => {
        expect(anyFilterActive(NO_FILTERS)).toBe(false);
    });

    it.each(['account', 'region', 'cluster', 'capacity'] as const)('is true when only %s is set', (key) => {
        expect(anyFilterActive({ ...NO_FILTERS, [key]: 'x' })).toBe(true);
    });
});

describe('hiddenFilterCount', () => {
    it('is 0 with no filters', () => {
        expect(hiddenFilterCount(NO_FILTERS)).toBe(0);
    });

    it('does NOT count a capacity the segmented control is already showing', () => {
        // The active segment is the indicator; badging it too double-reports one filter.
        expect(hiddenFilterCount({ ...NO_FILTERS, capacity: 'spot' })).toBe(0);
        expect(hiddenFilterCount({ ...NO_FILTERS, capacity: 'on_demand' })).toBe(0);
    });

    it('DOES count a capacity the segmented control cannot show', () => {
        // Otherwise 'mixed' is applied with nothing on screen indicating it.
        expect(hiddenFilterCount({ ...NO_FILTERS, capacity: 'mixed' })).toBe(1);
        expect(hiddenFilterCount({ ...NO_FILTERS, capacity: 'unknown' })).toBe(1);
    });

    it('counts each hidden dropdown once', () => {
        expect(hiddenFilterCount({ ...NO_FILTERS, account: '1', region: 'ap-south-1' })).toBe(2);
        expect(hiddenFilterCount({ account: '1', region: 'ap-south-1', cluster: 'c', capacity: 'all' })).toBe(3);
    });

    it('adds the hidden dropdowns to a non-representable capacity', () => {
        expect(hiddenFilterCount({ ...NO_FILTERS, account: '1', capacity: 'mixed' })).toBe(2);
    });
});
