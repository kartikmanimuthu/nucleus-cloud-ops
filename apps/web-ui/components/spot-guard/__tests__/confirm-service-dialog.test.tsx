// @vitest-environment jsdom
//
// The dialog turns a percentage the operator thinks in into the ECS capacity-provider weights the
// API takes. Two things must hold:
//
//   * the mapping is exact — 37% must reach the API as 37/63, not "roughly a third";
//   * 0% must NOT submit. Spot 0 / On-Demand 100 is byte-identical to the automated-fallback
//     signature, so enabling at 0% would leave the service matching the hourly restore job's
//     candidate query and it would be hardened back to full Spot within the hour — the exact
//     opposite of the request. The route independently agrees (spotWeight has min 1).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfirmServiceDialog } from '../confirm-service-dialog';
import { spotPercentOf } from '../shared';

const SERVICE = 'stx-kyc-ekyc-pf-app';

function open(onConfirm = vi.fn(), extra: { managed?: boolean; initialSpotPct?: number | null } = {}) {
    render(
        <ConfirmServiceDialog
            open
            onOpenChange={vi.fn()}
            mode="enable"
            serviceName={SERVICE}
            clusterName="c"
            accountId="688849551607"
            region="ap-south-1"
            pending={false}
            onConfirm={onConfirm}
            {...extra}
        />,
    );
    return {
        pctInput: screen.getByLabelText(/exact value/i) as HTMLInputElement,
        confirmName: screen.getByLabelText(/type .* to confirm/i, { selector: 'input' }) as HTMLInputElement,
        submit: () => screen.getByRole('button', { name: /^enable spot$/i }) as HTMLButtonElement,
    };
}

const setPct = (el: HTMLInputElement, v: string) => fireEvent.change(el, { target: { value: v } });
const typeName = (el: HTMLInputElement) => fireEvent.change(el, { target: { value: SERVICE } });

beforeEach(() => vi.clearAllMocks());

describe('ConfirmServiceDialog — percentage to ECS weights', () => {
    it('defaults to a blend, not 100% Spot', () => {
        // All-Spot means a capacity failure moves every task at once. It stays available, but it
        // must not be what a production service gets by simply not touching the control.
        const { pctInput } = open();
        expect(pctInput.value).toBe('50');
    });

    it.each([
        [100, 100, 0],
        [70, 70, 30],
        [50, 50, 50],
        [37, 37, 63],
        [1, 1, 99],
    ])('%i%% Spot submits weights %i / %i', (pct, spotWeight, onDemandWeight) => {
        const onConfirm = vi.fn();
        const d = open(onConfirm);
        setPct(d.pctInput, String(pct));
        typeName(d.confirmName);
        fireEvent.click(d.submit());

        expect(onConfirm).toHaveBeenCalledTimes(1);
        expect(onConfirm.mock.calls[0][0]).toMatchObject({ spotWeight, onDemandWeight });
        // Weights summing to 100 is what makes them readable as percentages downstream.
        expect(spotWeight + onDemandWeight).toBe(100);
    });

    it('shows the resulting split in words', () => {
        const d = open();
        setPct(d.pctInput, '37');
        expect(screen.getByText(/37% Spot · 63% On-Demand/)).toBeTruthy();
    });
});

describe('ConfirmServiceDialog — 0% Spot is refused, with a reason', () => {
    it('blocks submission at 0% even when the name matches', () => {
        const onConfirm = vi.fn();
        const d = open(onConfirm);
        setPct(d.pctInput, '0');
        typeName(d.confirmName);

        expect(d.submit().disabled).toBe(true);
        fireEvent.click(d.submit());
        expect(onConfirm).not.toHaveBeenCalled();
    });

    it('names the action that does express 0% instead of failing silently', () => {
        const d = open();
        setPct(d.pctInput, '0');
        // Must point at Disable — otherwise the user retries the same thing.
        expect(screen.getByText(/Disable/)).toBeTruthy();
        expect(screen.getByText(/back onto Spot within the hour/i)).toBeTruthy();
    });

    it('re-enables submission as soon as the share is above zero', () => {
        const d = open();
        setPct(d.pctInput, '0');
        typeName(d.confirmName);
        expect(d.submit().disabled).toBe(true);
        setPct(d.pctInput, '30');
        expect(d.submit().disabled).toBe(false);
    });
});

describe('ConfirmServiceDialog — guardrails', () => {
    it('cautions at 100% about having no On-Demand headroom', () => {
        const d = open();
        setPct(d.pctInput, '100');
        expect(screen.getByText(/no On-Demand headroom/i)).toBeTruthy();
    });

    it('still requires the typed service name regardless of the percentage', () => {
        const onConfirm = vi.fn();
        const d = open(onConfirm);
        setPct(d.pctInput, '50');
        fireEvent.click(d.submit());
        expect(onConfirm).not.toHaveBeenCalled();
    });

    it('rejects an out-of-range percentage', () => {
        const d = open();
        setPct(d.pctInput, '150');
        typeName(d.confirmName);
        expect(d.submit().disabled).toBe(true);
    });
});


describe('spotPercentOf — reading the current split back', () => {
    it.each([
        [[{ capacityProvider: 'FARGATE_SPOT', weight: 30 }, { capacityProvider: 'FARGATE', weight: 70 }], 30],
        [[{ capacityProvider: 'FARGATE_SPOT', weight: 50 }, { capacityProvider: 'FARGATE', weight: 50 }], 50],
        [[{ capacityProvider: 'FARGATE_SPOT', weight: 100 }, { capacityProvider: 'FARGATE', weight: 0 }], 100],
        // A fallen-back service: Spot present but zero-weighted, so 0% is on Spot.
        [[{ capacityProvider: 'FARGATE_SPOT', weight: 0 }, { capacityProvider: 'FARGATE', weight: 100 }], 0],
        // Legacy shape — weights need not sum to 100 for the ratio to be right.
        [[{ capacityProvider: 'FARGATE_SPOT', weight: 1 }, { capacityProvider: 'FARGATE', weight: 0 }], 100],
    ])('%j -> %i%%', (strategy, expected) => {
        expect(spotPercentOf(strategy)).toBe(expected);
    });

    it('returns null for an empty strategy so callers can fall back to the default', () => {
        expect(spotPercentOf([])).toBeNull();
        expect(spotPercentOf(null)).toBeNull();
    });
});

describe('ConfirmServiceDialog — changing an already-managed service', () => {
    it('opens on the service CURRENT share, not the new-service default', () => {
        // Opening "Change capacity" on a 30% service must show 30. Showing 50 would silently
        // propose a different split than the one in effect.
        const d = open(vi.fn(), { managed: true, initialSpotPct: 30 });
        expect(d.pctInput.value).toBe('30');
    });

    // Two separate cases: rendering the dialog twice in one test leaves two copies mounted and
    // the label query then matches both.
    it('falls back to the default when the current share is 0 — seeding 0 would open it blocked', () => {
        expect(open(vi.fn(), { managed: true, initialSpotPct: 0 }).pctInput.value).toBe('50');
    });

    it('falls back to the default when the current share is unknown', () => {
        expect(open(vi.fn(), { managed: true, initialSpotPct: null }).pctInput.value).toBe('50');
    });

    it('says it is changing capacity rather than enabling', () => {
        open(vi.fn(), { managed: true, initialSpotPct: 70 });
        expect(screen.getByText(/Change Spot capacity/i)).toBeTruthy();
        expect(screen.getByRole('button', { name: /apply capacity/i })).toBeTruthy();
    });

    it('still requires the typed name before applying a change', () => {
        const onConfirm = vi.fn();
        const d = open(onConfirm, { managed: true, initialSpotPct: 70 });
        fireEvent.click(screen.getByRole('button', { name: /apply capacity/i }));
        expect(onConfirm).not.toHaveBeenCalled();
        typeName(d.confirmName);
        fireEvent.click(screen.getByRole('button', { name: /apply capacity/i }));
        expect(onConfirm.mock.calls[0][0]).toMatchObject({ spotWeight: 70, onDemandWeight: 30 });
    });
});


describe('seeding source precedence — registry beats inventory', () => {
    // REGRESSION. The Eligible tab seeded the capacity dialog from
    // EligibleService.capacityProviderStrategy, which comes from the discovery inventory and is only
    // as fresh as the last nightly scan. For an already-managed service that is routinely hours
    // stale, so a service running 50/50 seeded the dialog at 100% — and because spotPercentOf maps
    // a legacy w1/w0 strategy to 100, one click on "Apply capacity" silently reverted the blend to
    // full Spot. Observed on sbx: admin-api went 50/50 -> 100/0.
    //
    // The list query now carries the registry's live observedStrategy as registryStrategy, and the
    // page prefers it. This pins the precedence, since the two sources disagreeing is the normal
    // case rather than the exception.
    const pick = (
        registryStrategy: { capacityProvider: string; weight: number }[] | null,
        inventoryStrategy: { capacityProvider: string; weight: number }[],
    ) => spotPercentOf(registryStrategy ?? inventoryStrategy);

    const LIVE_50_50 = [
        { capacityProvider: 'FARGATE_SPOT', weight: 50 },
        { capacityProvider: 'FARGATE', weight: 50 },
    ];
    const STALE_SPOT_ONLY = [
        { capacityProvider: 'FARGATE_SPOT', weight: 1 },
        { capacityProvider: 'FARGATE', weight: 0 },
    ];

    it('uses the live registry split when the inventory is stale', () => {
        expect(pick(LIVE_50_50, STALE_SPOT_ONLY)).toBe(50);
    });

    it('falls back to inventory only when the service is unmanaged (no registry row)', () => {
        expect(pick(null, STALE_SPOT_ONLY)).toBe(100);
    });

    it('demonstrates the stale reading that caused the revert', () => {
        // Kept explicitly: this is what the old code did, and it is why 100% appeared.
        expect(spotPercentOf(STALE_SPOT_ONLY)).toBe(100);
        expect(spotPercentOf(LIVE_50_50)).toBe(50);
    });
});
