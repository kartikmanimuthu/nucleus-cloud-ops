/**
 * Pure filter-toolbar logic for the Spot Guard page.
 *
 * Extracted from the page component so the two non-obvious rules — which segment reads as active,
 * and which active filters the "More filters" badge is responsible for — can be tested without
 * mounting the page and its eight query hooks.
 */

/**
 * The three capacity states worth a one-click filter.
 *
 * 'mixed' and 'unknown' are deliberately absent: a five-segment control stops being scannable, and
 * both states are rare. They stay reachable through the Capacity select in "More filters", which
 * writes the same piece of state this control reads.
 */
export const CAPACITY_SEGMENTS: [string, string][] = [
    ["all", "All"],
    ["spot", "On spot"],
    ["on_demand", "On-demand"],
];

/**
 * Every filter the toolbar owns. "all" means unset.
 *
 * Management state is deliberately absent: the Managed and Eligible tabs ARE that filter now
 * (managed vs. not-managed), so a dropdown repeating it could only contradict the tab it sits on.
 */
export interface SpotGuardFilterState {
    account: string;
    region: string;
    cluster: string;
    capacity: string;
}

export const NO_FILTERS: SpotGuardFilterState = {
    account: "all",
    region: "all",
    cluster: "all",
    capacity: "all",
};

/** True when the capacity value is one the segmented control can display. */
export function isSegmentedCapacity(capacity: string): boolean {
    return CAPACITY_SEGMENTS.some(([v]) => v === capacity);
}

/**
 * Value to hand the ToggleGroup — "" when the current capacity filter is one it cannot represent
 * ('mixed' / 'unknown'), so no segment lights up rather than "All" falsely claiming no filter.
 */
export function activeCapacitySegment(capacity: string): string {
    return isSegmentedCapacity(capacity) ? capacity : "";
}

export function anyFilterActive(f: SpotGuardFilterState): boolean {
    return Object.values(f).some((v) => v !== "all");
}

/**
 * How many active filters are NOT already visible on the toolbar — the number the badge on
 * "More filters" shows.
 *
 * Capacity counts only when the segmented control cannot display it. Otherwise the active segment
 * is already showing that filter, and badging it too would report one filter in two places.
 */
export function hiddenFilterCount(f: SpotGuardFilterState): number {
    const hidden = [f.account, f.region, f.cluster].filter((v) => v !== "all").length;
    return hidden + (isSegmentedCapacity(f.capacity) ? 0 : 1);
}
