// @vitest-environment jsdom
//
// Declared per-file — Vitest 4 removed environmentMatchGlobs, so
// vitest.config.ts's jsdom glob is inert (see components/rbac/__tests__/gated.test.tsx).

/**
 * Sync Selected must be gated on what POST /api/inventory/sync enforces:
 * update/Resource.
 *
 * Worth pinning rather than trusting the opener: the request it fires starts a
 * real multi-account AWS scan via STS AssumeRole, and the dialog and the
 * inventory page hold the gate independently — nothing stops the two drifting
 * apart except a test that names the pair.
 *
 * Both directions are pinned deliberately. A denied-only test passes just as
 * well against a button hardcoded to disabled, which would break Sync for
 * everyone.
 *
 * No jest-dom in this repo's Vitest setup, so assertions read raw DOM
 * properties rather than toBeDisabled().
 */
import { describe, expect, it, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';

import type { UIAccount } from '@/lib/types';

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
    useDenialReason: () => (allowed ? null : 'Requires Update on Inventory Resource'),
}));

import { SyncAccountsDialog } from '../sync-accounts-dialog';

/**
 * The dialog pre-selects every account it is given, so with one account the
 * `selected.size === 0` guard is satisfied and the permission gate is the only
 * thing that can disable the button — which is what makes the granted case a
 * real assertion rather than a tautology.
 */
const ACCOUNTS = [
    { accountId: '111111111111', name: 'prod', regions: ['ap-south-1'] },
] as unknown as UIAccount[];

const renderDialog = () =>
    render(
        <SyncAccountsDialog
            open
            onOpenChange={() => {}}
            accounts={ACCOUNTS}
            onSyncStarted={() => {}}
        />,
    );

const syncButton = () => screen.getByRole('button', { name: /sync selected/i }) as HTMLButtonElement;

describe('SyncAccountsDialog — Sync Selected is permission-gated', () => {
    it('disables Sync and surfaces the reason when Resource:update is denied', () => {
        allowed = false;
        renderDialog();

        const button = syncButton();
        expect(button.disabled).toBe(true);
        // The reason lives on the wrapper span: the primitive's
        // disabled:pointer-events-none would swallow a title on the button.
        expect(button.parentElement?.getAttribute('title')).toBe('Requires Update on Inventory Resource');
    });

    it('leaves Sync usable when Resource:update is granted', () => {
        allowed = true;
        renderDialog();

        const button = syncButton();
        expect(button.disabled).toBe(false);
        expect(button.parentElement?.getAttribute('title')).toBeNull();
    });
});
