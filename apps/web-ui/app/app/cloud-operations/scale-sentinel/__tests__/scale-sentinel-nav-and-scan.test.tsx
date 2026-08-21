// @vitest-environment jsdom
//
// Declared per-file — Vitest 4 removed environmentMatchGlobs, so
// vitest.config.ts's jsdom glob is inert (see hooks/__tests__/use-nav-gate.test.tsx).

/**
 * Scale Sentinel: the sidebar entry and the Run scan button.
 *
 * Two separate questions, deliberately in one file because they were reported
 * together and share the ScalingAudit subject:
 *
 *  1. NAV — /app/cloud-operations/scale-sentinel is owned by the ScalingAudit
 *     subject (seeded navPath, verified against the live registry). The entry
 *     carries no `module` annotation in nav-config.ts, so the subject is the
 *     only thing that can gate it. Pinned with the REAL navPaths, because the
 *     failure mode is a registry/nav mismatch that a synthetic path would hide.
 *
 *  2. RUN SCAN — POST /api/scaling-audit/runs enforces update/ScalingAudit and
 *     the button was ungated on a page with no gating whatsoever. Every other
 *     scaling-audit route (exports included) is `read`, so Run scan is the only
 *     control on the page that needs one.
 *
 * No jest-dom in this repo's Vitest setup, so assertions read raw DOM
 * properties rather than toBeDisabled().
 */
import { describe, expect, it, vi, beforeAll } from 'vitest';
import { render, renderHook, screen } from '@testing-library/react';
import { createMongoAbility } from '@casl/ability';
import { AbilityProvider as CaslAbilityProvider } from '@casl/react';
import type { ReactNode } from 'react';

import { AbilityMetaContext, type AbilityMeta } from '@/providers/ability-provider';
import { useNavGate } from '@/hooks/use-can';

const HREF = '/app/cloud-operations/scale-sentinel';

/**
 * The real seeded rows. Inventory's navPath is /app/inventory, which does NOT
 * claim the Scale Sentinel path — so if ScalingAudit ever lost its navPath,
 * resolveNavOwner would find no owner and the entry would fail OPEN. That is
 * the bug this fixture is shaped to catch.
 */
const META: AbilityMeta = {
    modules: [{ key: 'Inventory', label: 'Inventory', icon: null, navPath: '/app/inventory', sortOrder: 30 }],
    actions: [],
    subjects: [
        { key: 'Resource', label: 'Resource', kind: 'resource', moduleKey: 'Inventory', navPath: '/app/inventory', sortOrder: 10 },
        { key: 'ScalingAudit', label: 'Scale Sentinel', kind: 'resource', moduleKey: 'Inventory', navPath: HREF, sortOrder: 40 },
    ],
    moduleActions: [],
    actionAliases: {},
    version: '1.0',
    isLoaded: true,
};

function wrapperFor(rules: { action: string; subject: string; inverted?: boolean }[]) {
    const ability = createMongoAbility(rules as never);
    return function Wrapper({ children }: { children: ReactNode }) {
        return (
            <CaslAbilityProvider value={ability as never}>
                <AbilityMetaContext.Provider value={META}>{children}</AbilityMetaContext.Provider>
            </CaslAbilityProvider>
        );
    };
}

const navGate = (rules: { action: string; subject: string; inverted?: boolean }[]) =>
    renderHook(() => useNavGate(), { wrapper: wrapperFor(rules) }).result.current;

describe('Scale Sentinel sidebar entry follows ScalingAudit', () => {
    it('is hidden when the role holds nothing', () => {
        expect(navGate([]).canSeeHref(HREF)).toBe(false);
    });

    // The compiler expands a module-level grant into one rule PER SUBJECT, so a
    // plain "Inventory: read" tick really does grant read on ScalingAudit. The
    // entry being visible in that state is correct, not a leak — the row inherits.
    it('is visible when Inventory read expands onto it', () => {
        expect(
            navGate([
                { action: 'read', subject: 'Resource' },
                { action: 'read', subject: 'ScalingAudit' },
            ]).canSeeHref(HREF)
        ).toBe(true);
    });

    // "Inventory: read" with the Scale Sentinel row explicitly denied — what the
    // matrix writes when the module is ticked and the submodule is unticked.
    it('is hidden when the module grants read but the row is denied', () => {
        expect(
            navGate([
                { action: 'read', subject: 'Resource' },
                { action: 'read', subject: 'ScalingAudit' },
                { action: 'read', subject: 'ScalingAudit', inverted: true },
            ]).canSeeHref(HREF)
        ).toBe(false);
    });

    // Reading a SIBLING of the same module must not drag the entry into view.
    it('is hidden when only a sibling subject is readable', () => {
        expect(navGate([{ action: 'read', subject: 'Resource' }]).canSeeHref(HREF)).toBe(false);
    });
});

// ── Run scan ────────────────────────────────────────────────────────────────

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

vi.mock('@/hooks/use-can', async (importOriginal) => {
    // useNavGate above must stay REAL — only the gate the button consults is faked.
    const actual = await importOriginal<typeof import('@/hooks/use-can')>();
    return {
        ...actual,
        useCan: () => allowed,
        useDenialReason: (action: string, subject: string) =>
            allowed ? null : `Requires ${action} on ${subject}`,
    };
});

vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@tanstack/react-query', () => ({
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

const emptyList = { data: { data: [], total: 0 }, isLoading: false, error: null, refetch: vi.fn() };
const idle = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };

vi.mock('@/lib/queries/scaling-audit', () => ({
    useScalingEvents: () => emptyList,
    useScalingResources: () => emptyList,
    useScalingAuditSummary: () => ({ data: null, isLoading: false }),
    useScalingAuditCoverage: () => ({ data: [], isLoading: false }),
    useRunScalingAuditScan: () => idle,
    useExportScalingAudit: () => idle,
}));

vi.mock('@/lib/queries/capacity-planning', () => ({
    useCapacityUtilizationSummary: () => ({ data: null, isLoading: false }),
    useRunCapacityPlanningScan: () => idle,
}));

// The Direct Connect & VPN tab's report query — real @tanstack/react-query is
// mocked away wholesale below, so this must be mocked too or useQuery() inside
// the real (unmocked) network-links hook throws.
vi.mock('@/lib/queries/network-links', () => ({
    useNetworkAvailabilityReport: () => ({ data: [], isFetching: false }),
}));

// Only useAccounts is called from this page, but a partial module mock breaks
// any transitive import, so the surface is mocked whole.
vi.mock('@/lib/queries/accounts', () => ({
    useAccounts: () => ({ data: [], isLoading: false }),
    useAccountOptions: () => ({ options: [], isLoading: false }),
    useAccount: () => ({ data: null, isLoading: false }),
    useCreateAccount: () => idle,
    useUpdateAccount: () => idle,
    useDeleteAccount: () => idle,
    useScanResources: () => idle,
}));

import ScalingAuditPage from '../page';

describe('Run scan is gated on update/ScalingAudit', () => {
    /**
     * The REAL page is rendered, not a hand-built GatedButton. Asserting against
     * a local copy of the markup would keep passing if the page were reverted to
     * a plain <Button> — the "green against both the bug and the fix" trap.
     */
    it('disables Run scan with the reason when update is denied', () => {
        allowed = false;
        render(<ScalingAuditPage />);

        const button = screen.getByRole('button', { name: /run scan/i }) as HTMLButtonElement;
        expect(button.disabled).toBe(true);
        expect(button.parentElement?.getAttribute('title')).toBe('Requires update on ScalingAudit');
    });

    it('leaves Run scan usable when update is granted', () => {
        allowed = true;
        render(<ScalingAuditPage />);
        expect((screen.getByRole('button', { name: /run scan/i }) as HTMLButtonElement).disabled).toBe(false);
    });

    // Refresh and both exports ride on `read` routes — the permission that
    // already loaded the page. They must NOT acquire a gate: disabling a control
    // that cannot 403 is its own bug.
    it('leaves Refresh and the exports ungated even when denied', () => {
        allowed = false;
        render(<ScalingAuditPage />);

        for (const name of [/refresh/i, /export excel/i, /export pdf/i]) {
            const button = screen.getByRole('button', { name }) as HTMLButtonElement;
            expect(button.disabled).toBe(false);
        }
    });
});
