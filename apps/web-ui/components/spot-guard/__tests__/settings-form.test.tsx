// @vitest-environment jsdom
//
// Declared per-file — Vitest 4 removed environmentMatchGlobs, so
// vitest.config.ts's jsdom glob is inert (see components/rbac/__tests__/gated.test.tsx).

/**
 * Save settings must be gated on the same (action, subject) the route enforces.
 *
 * app/api/spot-guard/settings/route.ts's PUT calls authorize('update',
 * 'SpotGuard'). The button was a plain <Button>, so a role without that
 * permission got a fully live control and discovered the denial only as a 403
 * from the API — the exact failure GatedButton exists to prevent.
 *
 * Both directions are pinned deliberately. A denied-only test passes just as
 * well against a button hardcoded to disabled, which would break Save for
 * everyone.
 *
 * No jest-dom in this repo's Vitest setup, so assertions read raw DOM
 * properties rather than toBeDisabled().
 */
import { describe, expect, it, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// The Slack toggle is a Radix Switch, which measures itself. Same polyfill and
// same guard as components/rbac/__tests__/gated.test.tsx.
beforeAll(() => {
    if (typeof (globalThis as any).ResizeObserver === 'undefined') {
        (globalThis as any).ResizeObserver = class {
            observe() {}
            unobserve() {}
            disconnect() {}
        };
    }
});

let allowed = true;

vi.mock('@/hooks/use-can', () => ({
    useCan: () => allowed,
    useDenialReason: () => (allowed ? null : 'Requires Update on Spot Guard'),
}));

const mutate = vi.fn();

/**
 * Hoisted so the mock returns a STABLE identity. The component hydrates with
 * `useEffect(() => { if (data) form.reset(data) }, [data, form])`; a fresh object
 * literal per call makes that effect re-fire on every render, which loops until
 * React's update-depth guard trips — a defect in the test, not the component.
 */
const SAVED = { slackChannelId: '#claude-ops', slackEnabled: true, reportTimezone: 'Asia/Kolkata' };

vi.mock('@/lib/queries/spot-guard', () => ({
    useSpotGuardSettings: () => ({ data: SAVED, isLoading: false }),
    useSaveSpotGuardSettings: () => ({ mutate, isPending: false }),
}));

import { SpotGuardSettingsForm } from '../settings-form';

const saveButton = () => screen.getByRole('button', { name: /save settings/i }) as HTMLButtonElement;

/** The button starts disabled until the form is dirty, so every case edits a field first. */
const dirtyTheForm = () =>
    fireEvent.change(screen.getByLabelText('Slack channel'), { target: { value: '#somewhere-else' } });

describe('SpotGuardSettingsForm — Save settings is permission-gated', () => {
    beforeEach(() => {
        mutate.mockClear();
    });

    it('disables Save and surfaces the reason when SpotGuard:update is denied', () => {
        allowed = false;
        render(<SpotGuardSettingsForm />);
        dirtyTheForm();

        const button = saveButton();
        expect(button.disabled).toBe(true);
        // The reason lives on the wrapper span, not the button: the primitive's
        // disabled:pointer-events-none would swallow a title on the button itself.
        expect(button.parentElement?.getAttribute('title')).toBe('Requires Update on Spot Guard');

        // Belt and braces — a disabled control must not reach the mutation even
        // if a click is dispatched at it directly.
        fireEvent.click(button);
        expect(mutate).not.toHaveBeenCalled();
    });

    it('leaves Save working when SpotGuard:update is granted', () => {
        allowed = true;
        render(<SpotGuardSettingsForm />);
        dirtyTheForm();

        const button = saveButton();
        expect(button.disabled).toBe(false);
        expect(button.parentElement?.getAttribute('title')).toBeNull();
    });

    it('keeps Save disabled with nothing to save, even when granted', () => {
        allowed = true;
        render(<SpotGuardSettingsForm />);
        // No edit: the form is clean, so the existing isDirty guard still applies
        // and the gate has not replaced it.
        expect(saveButton().disabled).toBe(true);
    });
});
