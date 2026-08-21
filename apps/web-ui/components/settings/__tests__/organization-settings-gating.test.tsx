// @vitest-environment jsdom
//
// Declared per-file — Vitest 4 removed environmentMatchGlobs, so
// vitest.config.ts's jsdom glob is inert (see components/rbac/__tests__/gated.test.tsx).

/**
 * Organization Settings gates on Tenant, not the Settings module.
 *
 * PUT /api/tenants/settings and both handlers in /api/tenants/logo enforce
 * authorize('update', 'Tenant'). The form asked for `update Settings` — the
 * module-wide catch-all the role editor HIDES — so anyone holding the Settings
 * module kept a live Save Changes button while the server asked about the
 * 'Tenant' row, a real visible submodule that governed nothing here. The result
 * was an editable form and a 403.
 *
 * The test that matters is the third one: holding ONLY 'Settings' must no
 * longer be enough. A pass/fail pair on 'Tenant' alone would stay green against
 * the old code too, since a role with both would satisfy either question.
 *
 * The form hides the whole editing section rather than disabling it — a
 * deliberate, documented choice (a Member/Viewer should not learn the controls
 * exist), so absence, not `disabled`, is what is asserted.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

/**
 * vi.hoisted, so this runs BEFORE the component module is imported.
 *
 * organization-settings-form.tsx computes `const TIMEZONES =
 * Intl.supportedValuesOf("timeZone")` at module scope — ~600 entries, each a
 * Radix SelectItem, rendered on every case here. That was slow enough to push
 * not just these tests but their NEIGHBOURS in the same worker
 * (aiops-settings-gating, members-table) past the 5s default and fail them as
 * bare timeouts. Trimming the list keeps the cost local instead of raising
 * timeouts across the directory to accommodate one heavy test.
 *
 * ResizeObserver goes here too: the Timezone Select measures itself the moment
 * the form leaves its loading branch, inside an async effect. Installed any
 * later (a beforeAll), the miss surfaces as an unhandled ReferenceError and the
 * test just times out with nothing to point at.
 */
vi.hoisted(() => {
    const original = Intl.supportedValuesOf;
    (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf = (key: string) =>
        key === 'timeZone' ? ['UTC', 'Asia/Kolkata'] : original(key as never);

    if (typeof (globalThis as any).ResizeObserver === 'undefined') {
        (globalThis as any).ResizeObserver = class {
            observe() {}
            unobserve() {}
            disconnect() {}
        };
    }
});

/** Answers per (action, subject) so the two subjects can be told apart. */
let can: (action: string, subject: string) => boolean = () => true;

vi.mock('@/hooks/use-can', () => ({
    useCan: (action: string, subject: string) => can(action, subject),
    useDenialReason: () => null,
}));

vi.mock('next-auth/react', () => ({
    // isSuperAdmin must be false: it short-circuits canEdit, which would mask
    // the permission check entirely.
    useSession: () => ({ data: { user: { isSuperAdmin: false } }, status: 'authenticated' }),
}));

vi.mock('@/lib/tenant-context', () => ({
    useTenant: () => ({ tenant: { id: 't1', name: 'smc-global', slug: 'smc-global' } }),
}));

const SETTINGS = {
    name: 'smc-global',
    slug: 'smc-global',
    timezone: 'UTC',
    logoUrl: null,
    notifications: { scheduleExecutions: true, memberInvites: true, systemAlerts: true },
};

beforeEach(() => {
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: true, json: async () => ({ success: true, data: SETTINGS }) }))
    );
});

import { OrganizationSettingsForm } from '../organization-settings-form';

const saveButton = () => screen.queryByRole('button', { name: /save changes/i });

describe('Organization Settings gates on Tenant', () => {
    it('shows Save Changes when update/Tenant is granted', async () => {
        can = (action, subject) => action === 'update' && subject === 'Tenant';
        render(<OrganizationSettingsForm />);
        await waitFor(() => expect(saveButton()).not.toBeNull());
    });

    it('hides Save Changes when update/Tenant is denied', async () => {
        can = () => false;
        render(<OrganizationSettingsForm />);
        // Wait for the settings load to land, or absence proves nothing.
        await waitFor(() => expect(screen.getByText('Organization Settings')).toBeTruthy());
        expect(saveButton()).toBeNull();
    });

    // THE regression guard: the old code asked about the hidden Settings
    // catch-all, so this exact role kept an editable form and got a 403.
    it('does not accept update/Settings as a substitute', async () => {
        can = (action, subject) => action === 'update' && subject === 'Settings';
        render(<OrganizationSettingsForm />);
        await waitFor(() => expect(screen.getByText('Organization Settings')).toBeTruthy());
        expect(saveButton()).toBeNull();
    });
    // 30s, matching role-dialog.test.tsx. Even with the timezone list trimmed
    // above, this form (RHF + zodResolver, three Switches, a Select, an async
    // settings load) lands around 5s — right on the default, so it passed or
    // failed depending on machine load. The trim keeps the NEIGHBOURS fast; this
    // covers the cost that is genuinely this component's own.
}, 30000);
