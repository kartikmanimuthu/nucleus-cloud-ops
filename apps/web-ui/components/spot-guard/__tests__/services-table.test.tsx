// @vitest-environment jsdom
//
// The "Restoring…" state is the whole point of this component's restoringId prop.
//
// "Restore now" enqueues a job that the workers execute in an ephemeral ECS task ~60-90s later.
// Before this, the row was visually identical for that entire window and then never refreshed,
// so a restore that HAD succeeded looked like a button that did nothing. These tests pin the
// affordance that tells the user work is in progress, and that the row cannot be double-clicked
// into a second rolling deployment while it runs.
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ServicesTable } from '../services-table';
import type { SpotGuardService } from '@/lib/db/repositories/spot-guard/interface';

const service = (over: Partial<SpotGuardService> = {}): SpotGuardService =>
    ({
        id: 'svc-1',
        tenantId: 't1',
        accountId: '688849551607',
        region: 'ap-south-1',
        clusterName: 'stx-kyc-ekyc-ecs-fargate',
        serviceName: 'stx-kyc-ekyc-admin-api',
        desiredStrategy: [{ capacityProvider: 'FARGATE_SPOT', weight: 1, base: 0 }],
        observedStrategy: [{ capacityProvider: 'FARGATE', weight: 10, base: 0 }],
        capacityState: 'on_demand',
        managementState: 'managed',
        restorePending: true,
        consecutiveFailures: 0,
        interruptionCount: 0,
        placementFailureCount: 0,
        fallbackCount: 0,
        restoreCount: 0,
        ...over,
    }) as unknown as SpotGuardService;

const renderTable = (restoringId: string | null) =>
    render(
        <ServicesTable
            services={[service()]}
            loading={false}
            onRestore={vi.fn()}
            onDisable={vi.fn()}
            busyId={null}
            restoringId={restoringId}
        />,
    );

const restoreBtn = () => screen.getByRole('button', { name: /restore now/i }) as HTMLButtonElement;

describe('ServicesTable — Restore now is only offered when there is something to restore', () => {
    // Mirrors evaluateRestore's trigger: restorePending || isFallbackState(live), where
    // capacityState 'on_demand' is the persisted form of isFallbackState. Offering it on a
    // Spot service could only ever yield a 'nothing_to_do' skip.
    const render1 = (over: Partial<SpotGuardService>) =>
        render(
            <ServicesTable
                services={[service(over)]}
                loading={false}
                onRestore={vi.fn()}
                onDisable={vi.fn()}
                busyId={null}
                restoringId={null}
            />,
        );

    it('is ENABLED for an On-Demand service (it is in fallback)', () => {
        render1({ capacityState: 'on_demand', restorePending: false });
        expect(restoreBtn().disabled).toBe(false);
    });

    it('is DISABLED for a service already on Spot', () => {
        render1({ capacityState: 'spot', restorePending: false });
        expect(restoreBtn().disabled).toBe(true);
        expect(restoreBtn().title).toMatch(/nothing to restore/i);
    });

    it('is DISABLED for a deliberate mixed split — Spot is already carrying traffic', () => {
        render1({ capacityState: 'mixed', restorePending: false });
        expect(restoreBtn().disabled).toBe(true);
    });

    it('is ENABLED when a restore is owed, even if capacityState says Spot', () => {
        // capacityState can be stale; the worker re-derives from live AWS state, so the button
        // must not be the thing preventing a self-heal.
        render1({ capacityState: 'spot', restorePending: true });
        expect(restoreBtn().disabled).toBe(false);
    });

    it('is DISABLED for a service scaled to 0 tasks, even though it is in fallback', () => {
        // Non-prod is shut down nightly. The engine's scheduler_protection gate declines any
        // restore for a stopped service, so the button could only ever produce a skip.
        render1({ capacityState: 'on_demand', restorePending: true, desiredCount: 0 });
        expect(restoreBtn().disabled).toBe(true);
        expect(restoreBtn().title).toMatch(/scaled to 0 tasks/i);
    });

    it('is ENABLED once it scales back up', () => {
        render1({ capacityState: 'on_demand', restorePending: true, desiredCount: 2 });
        expect(restoreBtn().disabled).toBe(false);
    });

    it('is DISABLED for an unmanaged service regardless of capacity', () => {
        render1({ capacityState: 'on_demand', managementState: 'unmanaged' });
        expect(restoreBtn().disabled).toBe(true);
        expect(restoreBtn().title).toMatch(/only managed/i);
    });
});

describe('ServicesTable — restore-in-progress affordance', () => {
    it('shows "Restore now" when nothing is queued', () => {
        renderTable(null);
        expect(screen.getByRole('button', { name: /restore now/i })).toBeTruthy();
        expect(screen.queryByText(/restoring/i)).toBeNull();
    });

    it('shows "Restoring…" for the queued row', () => {
        renderTable('svc-1');
        expect(screen.getAllByText(/restoring/i).length).toBeGreaterThan(0);
        expect(screen.queryByRole('button', { name: /^restore now$/i })).toBeNull();
    });

    it('disables the row actions while a restore is queued', () => {
        // Each restore is an UpdateService with forceNewDeployment. Letting the user click again
        // mid-pass invites a second rolling deployment of the same production service.
        renderTable('svc-1');
        for (const b of screen.getAllByRole('button')) {
            expect((b as HTMLButtonElement).disabled).toBe(true);
        }
    });

    it('leaves other rows interactive — only the queued one is busy', () => {
        render(
            <ServicesTable
                services={[service(), service({ id: 'svc-2', serviceName: 'other-api' })]}
                loading={false}
                onRestore={vi.fn()}
                onDisable={vi.fn()}
                busyId={null}
                restoringId="svc-1"
            />,
        );
        const enabled = screen.getAllByRole('button').filter((b) => !(b as HTMLButtonElement).disabled);
        expect(enabled.length).toBeGreaterThan(0);
    });
});
