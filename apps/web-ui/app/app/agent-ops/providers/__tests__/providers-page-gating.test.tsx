// @vitest-environment jsdom
//
// Declared per-file — Vitest 4 removed environmentMatchGlobs, so
// vitest.config.ts's jsdom glob is inert (see components/rbac/__tests__/gated.test.tsx).

/**
 * The Providers screen gates on the Provider subject, not the AIOps module.
 *
 * All seven /api/settings/providers/* routes enforce read/update on 'Provider'
 * — the "LLM Provider" row seeded under AI Ops with navPath
 * /app/agent-ops/providers. They previously gated on the bare 'AIOps' module
 * catch-all, which the role editor hides, so the Provider row it already
 * rendered governed nothing and only the whole AI Ops checkbox had any effect.
 *
 * The assertion that carries the weight is the NEGATIVE one: the page must not
 * consult 'AIOps' at all. Checking only that Provider is asked would still pass
 * if a stray AIOps check were left behind gating some of the controls, which is
 * the half-migrated state this replaces.
 *
 * No jest-dom in this repo's Vitest setup, so assertions read raw DOM
 * properties rather than toBeDisabled().
 */
import { describe, expect, it, vi, beforeAll, beforeEach } from 'vitest';
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

/** Every (action, subject) pair the page asks about. */
const asked: Array<{ action: string; subject: string }> = [];
let allowed = true;

vi.mock('@/hooks/use-can', () => ({
    useCan: (action: string, subject: string) => {
        asked.push({ action, subject });
        return allowed;
    },
    useDenialReason: (action: string, subject: string) =>
        allowed ? null : `Requires ${action} on ${subject}`,
}));

const PROVIDER = {
    id: 'prov-1',
    name: 'Bedrock prod',
    provider: 'bedrock',
    isDefault: true,
    isEnabled: true,
    credentialsConfigured: true,
    models: [],
};

const idle = { mutateAsync: vi.fn(), isPending: false };

vi.mock('@/lib/queries/providers', () => ({
    useProviders: () => ({ data: [PROVIDER], isLoading: false, error: null }),
    useProviderModels: () => ({ data: [] }),
    useDeleteProvider: () => idle,
    useToggleProvider: () => idle,
    useSetDefaultProvider: () => idle,
    useRefreshModels: () => idle,
}));

import ProvidersPage from '../page';

describe('Providers page gates on Provider, not the AIOps catch-all', () => {
    beforeEach(() => {
        asked.length = 0;
    });

    it('asks for update/Provider and never for AIOps', () => {
        allowed = true;
        render(<ProvidersPage />);

        expect(asked.some((q) => q.action === 'update' && q.subject === 'Provider')).toBe(true);
        // The whole point of the move: the hidden module catch-all must not be
        // what decides this screen.
        expect(asked.some((q) => q.subject === 'AIOps')).toBe(false);
    });

    it('disables New Provider with the reason when update/Provider is denied', () => {
        allowed = false;
        render(<ProvidersPage />);

        const link = screen.getByText('New Provider').closest('a');
        // Denied + asChild is rebuilt as a real <button>: an anchor has no
        // disabled attribute, so a denied link would otherwise stay clickable.
        expect(link).toBeNull();

        const button = screen.getAllByRole('button', { name: /new provider/i })[0] as HTMLButtonElement;
        expect(button.disabled).toBe(true);
        expect(button.parentElement?.getAttribute('title')).toBe('Requires update on Provider');
    });

    it('leaves New Provider usable when granted', () => {
        allowed = true;
        render(<ProvidersPage />);

        // Granted, the control stays a real navigation link.
        expect(screen.getByText('New Provider').closest('a')?.getAttribute('href')).toBe(
            '/app/agent-ops/providers/new'
        );
    });
});
