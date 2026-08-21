// @vitest-environment jsdom
//
// Declared per-file — Vitest 4 removed environmentMatchGlobs, so
// vitest.config.ts's jsdom glob is inert (see components/rbac/__tests__/gated.test.tsx).

/**
 * Save must be DISABLED with a reason when the caller cannot edit — never hidden.
 *
 * It used to render `canEdit && <Button>`, so a denied operator got a settings
 * form with no way to submit it and nothing on screen saying why. That is the
 * failure mode components/rbac/gated.tsx argues against explicitly ("a control
 * that vanishes is indistinguishable from a broken page"), and only a test that
 * asserts the button is PRESENT stops it reverting.
 *
 * The reason is asserted on the wrapper, not the button: the Button primitive
 * carries `disabled:pointer-events-none`, so a disabled button gets no hover and
 * a title on it would never be reachable.
 *
 * No jest-dom in this repo's Vitest setup, so assertions read raw DOM
 * properties rather than toBeDisabled().
 */
import { describe, expect, it, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';

beforeAll(() => {
    if (typeof (globalThis as any).ResizeObserver === 'undefined') {
        (globalThis as any).ResizeObserver = class {
            observe() {}
            unobserve() {}
            disconnect() {}
        };
    }
});

const SETTINGS = { period: 'daily', lastRunAt: null, nextEligibleAt: null };

vi.mock('@/lib/queries/discovery-settings', () => ({
    useDiscoverySettings: () => ({ data: SETTINGS, isLoading: false }),
    useSaveDiscoverySettings: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/tenant-context', () => ({ useTenant: () => ({ timezone: 'UTC' }) }));

import { DiscoverySettings } from '../discovery-settings';

const saveButton = () => screen.getByRole('button', { name: /^save$/i }) as HTMLButtonElement;

describe('DiscoverySettings — Save is disabled, not hidden, when denied', () => {
    it('renders Save disabled and carries the denial reason', () => {
        render(<DiscoverySettings canEdit={false} canEditReason="Requires Update on Inventory Resource" />);

        // PRESENT is the point of this assertion — the old code removed it.
        const button = saveButton();
        expect(button.disabled).toBe(true);
        expect(button.parentElement?.getAttribute('title')).toBe('Requires Update on Inventory Resource');
        expect(button.parentElement?.getAttribute('aria-disabled')).toBe('true');
    });

    it('leaves Save enabled and unannotated when permitted', () => {
        render(<DiscoverySettings canEdit canEditReason={null} />);

        const button = saveButton();
        expect(button.disabled).toBe(false);
        expect(button.parentElement?.getAttribute('title')).toBeNull();
        expect(button.parentElement?.getAttribute('aria-disabled')).toBeNull();
    });
});
