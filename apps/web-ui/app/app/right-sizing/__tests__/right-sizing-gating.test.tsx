// @vitest-environment jsdom
//
// Declared per-file — Vitest 4 removed environmentMatchGlobs, so
// vitest.config.ts's jsdom glob is inert (see components/rbac/__tests__/gated.test.tsx).

/**
 * Right Sizing's write controls gate on update/RightSizing.
 *
 * Neither surface had any gating at all, and both write through routes that
 * enforce it:
 *   Run scan (list page)                 -> POST  /api/right-sizing/runs
 *   Snooze / Dismiss / Approve (detail)  -> PATCH /api/right-sizing/recommendations/:id
 *
 * Both are covered here because they share one subject and one verb — gating the
 * reported button alone would leave the same denial reachable one click deeper,
 * on the page this one links to.
 *
 * The real page and the real detail component are rendered, not local copies of
 * their markup: a hand-built GatedButton would keep passing if either were
 * reverted to a plain <Button>, which is the exact bug under repair.
 *
 * No jest-dom in this repo's Vitest setup, so assertions read raw DOM
 * properties rather than toBeDisabled().
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.hoisted(() => {
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
    useDenialReason: (action: string, subject: string) =>
        allowed ? null : `Requires ${action} on ${subject}`,
}));

vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@tanstack/react-query', () => ({
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

const idle = { mutate: vi.fn(), mutateAsync: vi.fn(async () => ({})), isPending: false };

/**
 * Every field the detail component dereferences — it reads metricsSummary and
 * currentMonthlyCost unguarded, so a thinner fixture throws during render and
 * the gate assertions never run.
 */
const RECOMMENDATION = {
    id: 'rec-1',
    name: 'i-0abc',
    resourceId: 'i-0abc',
    resourceType: 'ec2',
    finding: 'over_provisioned',
    status: 'open',
    rationale: 'CPU below 10% for 14 days.',
    currentMonthlyCost: 120,
    estimatedMonthlySavings: 42,
    confidence: 'high',
    riskLevel: 'low',
    metricsSummary: { coverageDays: 14, cpu: { p95: 8, avg: 4 }, memory: null },
};

vi.mock('@/lib/queries/right-sizing', () => ({
    useRightSizingRecommendations: () => ({ data: { data: [], total: 0 }, isLoading: false, isFetching: false }),
    useRightSizingSummary: () => ({ data: null, isLoading: false, isFetching: false }),
    useRunRightSizingScan: () => idle,
    // The detail query returns an ENVELOPE — { recommendation, resource, account }
    // — not the record itself, and the component destructures it directly.
    useRightSizingRecommendation: () => ({
        data: { recommendation: RECOMMENDATION, resource: null, account: null },
        isLoading: false,
        error: null,
    }),
    useUpdateRightSizingRecommendation: () => idle,
}));

vi.mock('@/lib/queries/accounts', () => ({
    useAccounts: () => ({ data: { accounts: [] }, isLoading: false }),
    useAccountOptions: () => ({ options: [], isLoading: false }),
    useAccount: () => ({ data: null, isLoading: false }),
    useCreateAccount: () => idle,
    useUpdateAccount: () => idle,
    useDeleteAccount: () => idle,
    useScanResources: () => idle,
}));

/**
 * The chart and context panel are stubbed: they read deep into metricsSummary
 * and the resource envelope, and reproducing that shape faithfully would make
 * this test about CloudWatch data rather than about permissions. The gated
 * buttons sit outside both.
 */
vi.mock('@/components/right-sizing/metric-charts', () => ({ MetricCharts: () => null }));
vi.mock('@/components/right-sizing/resource-context-panel', () => ({ ResourceContextPanel: () => null }));

import RightSizingPage from '../page';
import { RecommendationDetailPage } from '@/components/right-sizing/recommendation-detail-page';

const byName = (name: RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;

describe('Right Sizing write controls gate on update/RightSizing', () => {
    it('disables Run scan with the reason when denied', () => {
        allowed = false;
        render(<RightSizingPage />);

        const button = byName(/run scan/i);
        expect(button.disabled).toBe(true);
        expect(button.parentElement?.getAttribute('title')).toBe('Requires update on RightSizing');
    });

    it('leaves Run scan usable when granted', () => {
        allowed = true;
        render(<RightSizingPage />);
        expect(byName(/run scan/i).disabled).toBe(false);
    });

    // Refresh reads the same endpoints that already populated the page, so it
    // must NOT acquire a gate — disabling a control that cannot 403 is its own bug.
    it('leaves Refresh ungated even when denied', () => {
        allowed = false;
        render(<RightSizingPage />);
        expect(byName(/refresh/i).disabled).toBe(false);
    });
});

describe('Recommendation detail actions gate on update/RightSizing', () => {
    // All three write the same row through the same PATCH. Asserting only one
    // would let the other two regress silently, and a denied user reaching
    // Approve is the consequence that actually matters here.
    const ACTIONS = [/snooze/i, /dismiss/i, /approve/i] as const;

    it('disables Snooze, Dismiss and Approve with the reason when denied', () => {
        allowed = false;
        render(<RecommendationDetailPage recommendationId="rec-1" />);

        for (const name of ACTIONS) {
            const button = byName(name);
            expect(button.disabled).toBe(true);
            expect(button.parentElement?.getAttribute('title')).toBe('Requires update on RightSizing');
        }
    });

    it('leaves Dismiss and Approve usable when granted', () => {
        allowed = true;
        render(<RecommendationDetailPage recommendationId="rec-1" />);

        // Snooze is excluded on purpose: it carries its own `!snoozeDate` guard,
        // so it stays disabled until a date is picked even for a permitted user.
        // Asserting it here would pin the wrong reason for it being inert.
        for (const name of [/dismiss/i, /approve/i] as const) {
            expect(byName(name).disabled).toBe(false);
        }
    });
});
