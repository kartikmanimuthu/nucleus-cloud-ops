// @vitest-environment jsdom
//
// The Strategy column used to render the raw AWS form, "FARGATE_SPOT w1 / FARGATE w0 DISCOVERED".
// Two things were wrong with it: ECS weights are relative ratios, so w1/w0 and w100/w0 are the
// same configuration and the raw string hid that; and the staleness flag was concatenated onto the
// end, where it read as part of the AWS configuration rather than as a caveat about it.
//
// These tests pin the plain-language rendering, and in particular that equivalent ratios collapse
// to the same label — which is the property that makes the column readable at all.
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CapacityBadge, StrategySummary, strategyWeights } from '../shared';
import type { CapacityProviderStrategyItem } from '@/lib/db/repositories/spot-guard/interface';

const spot = (weight: number): CapacityProviderStrategyItem =>
    ({ capacityProvider: 'FARGATE_SPOT', weight, base: 0 }) as CapacityProviderStrategyItem;
const onDemand = (weight: number): CapacityProviderStrategyItem =>
    ({ capacityProvider: 'FARGATE', weight, base: 0 }) as CapacityProviderStrategyItem;

describe('StrategySummary', () => {
    it('renders all-Spot as a percentage, not as weights', () => {
        render(<StrategySummary strategy={[spot(1), onDemand(0)]} />);
        expect(screen.getByText('100% Spot')).toBeTruthy();
        expect(screen.getByText('spot 1 · on-demand 0')).toBeTruthy();
    });

    it('reads w1/w0 and w100/w0 as the SAME configuration', () => {
        // The bug the old rendering caused: two services on identical strategies looked different.
        const { unmount } = render(<StrategySummary strategy={[spot(1), onDemand(0)]} />);
        expect(screen.getByText('100% Spot')).toBeTruthy();
        unmount();

        render(<StrategySummary strategy={[spot(100), onDemand(0)]} />);
        expect(screen.getByText('100% Spot')).toBeTruthy();
    });

    it('renders all-On-Demand', () => {
        render(<StrategySummary strategy={[spot(0), onDemand(100)]} />);
        expect(screen.getByText('100% On-demand')).toBeTruthy();
        expect(screen.getByText('spot 0 · on-demand 100')).toBeTruthy();
    });

    it('renders a blended split by its real Spot share', () => {
        // The case a plain "On spot" / "On-demand" badge cannot express, and the one that is now
        // the default path for prod (30/70, 50/50).
        render(<StrategySummary strategy={[spot(30), onDemand(70)]} />);
        expect(screen.getByText('30% Spot')).toBeTruthy();
        expect(screen.getByText('spot 30 · on-demand 70')).toBeTruthy();
    });

    it('keeps the exact AWS form available on hover rather than discarding it', () => {
        render(<StrategySummary strategy={[spot(30), onDemand(70)]} />);
        expect(screen.getByText('30% Spot').getAttribute('title')).toBe('FARGATE_SPOT w30 / FARGATE w70');
    });

    it('renders an em dash for no strategy at all', () => {
        render(<StrategySummary strategy={[]} />);
        expect(screen.getByText('—')).toBeTruthy();
    });

    describe('the discovered flag', () => {
        it('is a separate tag, never concatenated into the strategy text', () => {
            render(<StrategySummary strategy={[spot(1), onDemand(0)]} fromInventory />);

            const tag = screen.getByText('discovered');
            // Its own element with its own explanation...
            expect(tag.getAttribute('title')).toMatch(/not a live read/i);
            // ...and the label beside it says nothing about it.
            expect(screen.getByText('100% Spot').textContent).toBe('100% Spot');
        });

        it('is absent for a strategy Spot Guard read live', () => {
            render(<StrategySummary strategy={[spot(1), onDemand(0)]} />);
            expect(screen.queryByText('discovered')).toBeNull();
        });
    });
});

/**
 * capacityState is learned from task-state events — which provider the most recent RUNNING task
 * launched on. A service scaled to zero emits no task events, so the value simply stops moving and
 * the badge keeps asserting "On Spot" for something that has been running nothing for hours.
 *
 * Non-prod is shut down nightly, so this is the normal overnight state of every managed service,
 * not a rare edge case.
 */
describe('CapacityBadge when the service is scaled down', () => {
    it('reads "Stopped" rather than claiming a capacity', () => {
        render(<CapacityBadge state="spot" desiredCount={0} />);
        expect(screen.getByText('Stopped')).toBeTruthy();
        expect(screen.queryByText('On Spot')).toBeNull();
    });

    it('keeps the last known capacity in the tooltip rather than discarding it', () => {
        render(<CapacityBadge state="on_demand" desiredCount={0} />);
        expect(screen.getByText('Stopped').getAttribute('title')).toMatch(/Last observed capacity: On-Demand/);
    });

    it('shows the capacity normally for a running service', () => {
        render(<CapacityBadge state="spot" desiredCount={2} />);
        expect(screen.getByText('On Spot')).toBeTruthy();
        expect(screen.queryByText('Stopped')).toBeNull();
    });

    it.each([undefined, null])('treats desiredCount %s as "never observed", not stopped', (count) => {
        // Only a literal 0 means scaled down. Absent data must not be reported as stopped.
        render(<CapacityBadge state="spot" desiredCount={count} />);
        expect(screen.getByText('On Spot')).toBeTruthy();
    });

    it('does not fall for a falsy-but-not-zero value', () => {
        render(<CapacityBadge state="spot" />);
        expect(screen.getByText('On Spot')).toBeTruthy();
    });
});

/**
 * A blended service used to read "On Spot" or "On-Demand" at random.
 *
 * capacityState cannot express a blend: in steady state the only writer is the task-event path, and
 * classifyCapacity() maps ONE task's provider to 'spot' or 'on_demand'. So a 50/50 service displayed
 * whichever provider the most recent task to start happened to use, and flipped as tasks cycled.
 * deriveCapacityState() does return 'mixed', but its only caller is the placement-failure path, so a
 * healthy blend never reached it.
 */
describe('CapacityBadge for a blended strategy', () => {
    const blend = [
        { capacityProvider: 'FARGATE_SPOT', weight: 50, base: 0 },
        { capacityProvider: 'FARGATE', weight: 50, base: 0 },
    ] as CapacityProviderStrategyItem[];

    it('reads "Mixed" for a 50/50 even though capacityState says spot', () => {
        render(<CapacityBadge state="spot" desiredCount={4} strategy={blend} />);
        expect(screen.getByText('Mixed')).toBeTruthy();
        expect(screen.queryByText('On Spot')).toBeNull();
    });

    it('reads "Mixed" regardless of which provider the last task used', () => {
        // The same service, the same strategy, the other capacityState — must not change the label.
        render(<CapacityBadge state="on_demand" desiredCount={4} strategy={blend} />);
        expect(screen.getByText('Mixed')).toBeTruthy();
    });

    it('keeps the per-task detail in the tooltip rather than dropping it', () => {
        render(<CapacityBadge state="spot" desiredCount={4} strategy={blend} />);
        const title = screen.getByText('Mixed').getAttribute('title');
        expect(title).toMatch(/50% Spot \/ 50% On-Demand/);
        expect(title).toMatch(/Most recent task ran on On Spot/);
    });

    it('is NOT mixed at the extremes', () => {
        const { unmount } = render(
            <CapacityBadge state="spot" desiredCount={4} strategy={[spot(1), onDemand(0)]} />,
        );
        expect(screen.getByText('On Spot')).toBeTruthy();
        unmount();

        // Fallback: Spot present but zero-weighted is not a split, so On-Demand is correct.
        render(<CapacityBadge state="on_demand" desiredCount={4} strategy={[spot(0), onDemand(100)]} />);
        expect(screen.getByText('On-Demand')).toBeTruthy();
    });

    it('Stopped beats Mixed — nothing running is the more important fact', () => {
        render(<CapacityBadge state="spot" desiredCount={0} strategy={blend} />);
        expect(screen.getByText('Stopped')).toBeTruthy();
    });

    it('falls back to capacityState when no strategy is supplied', () => {
        render(<CapacityBadge state="spot" desiredCount={4} />);
        expect(screen.getByText('On Spot')).toBeTruthy();
    });
});

describe('strategyWeights', () => {
    it('sums each side rather than reading positionally', () => {
        // A strategy may list more than one provider per side, in any order.
        expect(strategyWeights([onDemand(5), spot(20), spot(10)])).toEqual({ spot: 30, onDemand: 5 });
    });

    it('treats a missing weight as 0', () => {
        expect(strategyWeights([{ capacityProvider: 'FARGATE_SPOT' } as CapacityProviderStrategyItem])).toEqual({
            spot: 0,
            onDemand: 0,
        });
    });

    it('classifies by name, so FARGATE_SPOT counts as Spot and FARGATE does not', () => {
        expect(strategyWeights([spot(1)]).spot).toBe(1);
        expect(strategyWeights([onDemand(1)]).onDemand).toBe(1);
    });
});
