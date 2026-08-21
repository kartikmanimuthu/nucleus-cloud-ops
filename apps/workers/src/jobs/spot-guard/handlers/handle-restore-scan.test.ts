// workers/src/jobs/spot-guard/handlers/handle-restore-scan.test.ts
//
// The restore handler had NO test before this file, which is how a whole class of silent
// behaviour survived: a manual "Restore now" that the worker declined produced no timeline row
// and no log above debug, so the UI had nothing to show and the button looked broken.
//
// What these tests pin down:
//   * a MANUAL skip always writes a timeline row, for every one of the four skip paths;
//   * a SCHEDULED skip still writes nothing for 'nothing_to_do' (it fires hourly for every
//     healthy service — recording it would bury real events);
//   * a scheduled skip for an *interesting* reason is still recorded, as before;
//   * eventType stays inside the two values the CHECK constraint allows.
//
// The engine is deliberately NOT mocked: it is pure, and driving it with real row/live state
// means these tests exercise the same gate ordering production does.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CapacityProviderStrategyItem } from '../types.js';

const {
    listRestoreCandidates,
    writeEvent,
    claimAction,
    countRestoresInLast24h,
    recordRestoreSuccess,
    recordAppliedStrategy,
    upsertObservedService,
    armBackoffOnly,
    createSpokeClients,
    describeServiceState,
    updateCapacityProvider,
    enforceDeregistrationDelay,
    notify,
    writeAuditLog,
    query,
} = vi.hoisted(() => ({
    listRestoreCandidates: vi.fn(),
    writeEvent: vi.fn(),
    claimAction: vi.fn(),
    countRestoresInLast24h: vi.fn(),
    recordRestoreSuccess: vi.fn(),
    recordAppliedStrategy: vi.fn(),
    upsertObservedService: vi.fn(),
    armBackoffOnly: vi.fn(),
    createSpokeClients: vi.fn(),
    describeServiceState: vi.fn(),
    updateCapacityProvider: vi.fn(),
    enforceDeregistrationDelay: vi.fn(),
    notify: vi.fn(),
    writeAuditLog: vi.fn(),
    query: vi.fn(),
}));

vi.mock('../services/db-writer.js', async () => {
    const actual = await vi.importActual<typeof import('../services/db-writer.js')>('../services/db-writer.js');
    return {
        ...actual,
        listRestoreCandidates,
        writeEvent,
        claimAction,
        countRestoresInLast24h,
        recordRestoreSuccess,
        recordAppliedStrategy,
        upsertObservedService,
        armBackoffOnly,
    };
});
vi.mock('../services/ecs-client.js', async () => {
    const actual = await vi.importActual<typeof import('../services/ecs-client.js')>('../services/ecs-client.js');
    return { ...actual, createSpokeClients, describeServiceState, updateCapacityProvider, enforceDeregistrationDelay };
});
vi.mock('../services/notifier.js', () => ({ notify }));
vi.mock('../../discovery/services/audit-service.js', () => ({ writeAuditLog }));
vi.mock('../../discovery/services/db.js', () => ({
    getPool: () => ({ connect: async () => ({ query, release: () => {} }) }),
}));

const { handleSpotGuardRestoreScan } = await import('./handle-restore-scan.js');

const TENANT = 'tenant-a';
const ACCOUNT = '688849551607';

const strategy = (spotWeight: number, onDemandWeight: number): CapacityProviderStrategyItem[] => [
    { capacityProvider: 'FARGATE_SPOT', weight: spotWeight, base: 0 },
    { capacityProvider: 'FARGATE', weight: onDemandWeight, base: 0 },
];

const row = (over: Partial<Record<string, unknown>> = {}) => ({
    id: 'svc-1',
    tenantId: TENANT,
    accountId: ACCOUNT,
    region: 'ap-south-1',
    clusterName: 'stx-kyc-ekyc-ecs-fargate',
    serviceName: 'stx-kyc-ekyc-admin-api',
    // A restorable baseline: Spot present with weight.
    desiredStrategy: strategy(1, 0),
    observedStrategy: strategy(0, 10),
    capacityState: 'on_demand',
    managementState: 'managed',
    restorePending: true,
    backoffUntil: null,
    consecutiveFailures: 0,
    ...over,
});

/** Live state that is healthy and already on Spot — the 'nothing_to_do' shape. */
const liveOnSpot = {
    raw: { clusterArn: `arn:aws:ecs:ap-south-1:${ACCOUNT}:cluster/stx-kyc-ekyc-ecs-fargate` },
    state: {
        currentStrategy: strategy(1, 0),
        desiredCount: 1,
        status: 'ACTIVE',
        hasLoadBalancers: false,
        deploymentInProgress: false,
    },
};

/** Live state observably in fallback — Spot present but zero-weighted. */
const liveInFallback = {
    ...liveOnSpot,
    state: { ...liveOnSpot.state, currentStrategy: strategy(0, 10) },
};

/** The two account queries the handler makes: acting-tenant election, then the binding. */
function pool(opts: { actingTenant?: string | null; binding?: boolean } = {}) {
    const acting = opts.actingTenant === undefined ? TENANT : opts.actingTenant;
    query.mockImplementation(async (sql: string) => {
        if (sql.includes('ORDER BY "tenantId" ASC')) {
            return { rows: acting ? [{ tenantId: acting }] : [] };
        }
        // findBinding
        return {
            rows:
                opts.binding === false
                    ? []
                    : [{ tenantId: TENANT, accountId: ACCOUNT, roleArn: 'arn:aws:iam::x:role/y', externalId: 'e', regions: ['ap-south-1'] }],
        };
    });
}

const skipEvents = () => writeEvent.mock.calls.map((c) => c[0]);

beforeEach(() => {
    vi.clearAllMocks();
    pool();
    createSpokeClients.mockResolvedValue({ ecs: {}, elbv2: {} });
    describeServiceState.mockResolvedValue(liveOnSpot);
    countRestoresInLast24h.mockResolvedValue(0);
    claimAction.mockResolvedValue(true);
});

describe('handleSpotGuardRestoreScan — manual skips are always recorded', () => {
    it('records a skip when this tenant is not the acting tenant', async () => {
        pool({ actingTenant: 'tenant-zzz' }); // someone else sorts first
        listRestoreCandidates.mockResolvedValue([row()]);

        await handleSpotGuardRestoreScan({ tenantId: TENANT, trigger: 'manual', force: true });

        expect(skipEvents()).toHaveLength(1);
        expect(skipEvents()[0].eventType).toBe('governance_skip');
        expect(skipEvents()[0].message).toContain('not_acting_tenant');
    });

    it('records a skip when the account binding is gone', async () => {
        pool({ binding: false });
        listRestoreCandidates.mockResolvedValue([row()]);

        await handleSpotGuardRestoreScan({ tenantId: TENANT, trigger: 'manual', force: true });

        expect(skipEvents()[0].message).toContain('no_active_account_binding');
    });

    it("records 'nothing_to_do' — the case that made the button look broken", async () => {
        // The service is already on Spot, so the engine correctly declines. Before this fix
        // that produced no event and only a debug log, i.e. total silence for the user.
        listRestoreCandidates.mockResolvedValue([row({ restorePending: false })]);
        describeServiceState.mockResolvedValue(liveOnSpot);

        await handleSpotGuardRestoreScan({ tenantId: TENANT, trigger: 'manual', force: true });

        expect(skipEvents()).toHaveLength(1);
        expect(skipEvents()[0].eventType).toBe('governance_skip');
        expect(skipEvents()[0].message).toContain('nothing_to_do');
        expect(updateCapacityProvider).not.toHaveBeenCalled();
    });

    it('records a skip when another replica already claimed this minute', async () => {
        claimAction.mockResolvedValue(false);
        listRestoreCandidates.mockResolvedValue([row()]);
        describeServiceState.mockResolvedValue(liveInFallback);

        await handleSpotGuardRestoreScan({ tenantId: TENANT, trigger: 'manual', force: true });

        expect(skipEvents()[0].message).toContain('already_claimed_this_minute');
        expect(updateCapacityProvider).not.toHaveBeenCalled();
    });

    it('only ever uses eventTypes the CHECK constraint allows', async () => {
        // spot_guard_events_event_type_check pins 13 values; inventing one here would make
        // every INSERT fail at runtime (and the repository would swallow it).
        pool({ actingTenant: 'tenant-zzz' });
        listRestoreCandidates.mockResolvedValue([row()]);
        await handleSpotGuardRestoreScan({ tenantId: TENANT, trigger: 'manual', force: true });
        for (const e of skipEvents()) {
            expect(['governance_skip', 'backoff_skip']).toContain(e.eventType);
        }
    });
});

/**
 * Non-prod environments get shut down overnight, so every managed service sits at desiredCount 0
 * for hours. The engine correctly declines to act (scheduler_protection — restoring would
 * forceNewDeployment a stopped service and fight the Cost Scheduler), but every scheduled pass used
 * to record that decline on the timeline: one row per service per hour, all night, saying nothing
 * except "still switched off". Ten hours across nine services is ninety rows of noise, which is
 * precisely what buries the fallbacks and restores the feed exists to surface.
 */
describe('handleSpotGuardRestoreScan — a service scaled to zero overnight', () => {
    /** Live state for a service the Cost Scheduler has switched off. */
    const liveStopped = {
        ...liveInFallback,
        state: { ...liveInFallback.state, desiredCount: 0, runningCount: 0 },
    };

    it('writes NO timeline row on a scheduled pass', async () => {
        listRestoreCandidates.mockResolvedValue([row()]);
        describeServiceState.mockResolvedValue(liveStopped);

        await handleSpotGuardRestoreScan({ tenantId: TENANT, trigger: 'schedule' });

        expect(writeEvent).not.toHaveBeenCalled();
    });

    it('still records it for a MANUAL trigger — someone pressed a button and is owed an answer', async () => {
        listRestoreCandidates.mockResolvedValue([row()]);
        describeServiceState.mockResolvedValue(liveStopped);

        await handleSpotGuardRestoreScan({ tenantId: TENANT, trigger: 'manual', force: true });

        expect(skipEvents()).toHaveLength(1);
        expect(skipEvents()[0].message).toContain('scheduler_protection');
    });

    it('never mutates a stopped service', async () => {
        listRestoreCandidates.mockResolvedValue([row()]);
        describeServiceState.mockResolvedValue(liveStopped);

        await handleSpotGuardRestoreScan({ tenantId: TENANT, trigger: 'manual', force: true });

        // force bypasses the backoff only — it must never bypass a safety gate.
        expect(updateCapacityProvider).not.toHaveBeenCalled();
        expect(recordAppliedStrategy).not.toHaveBeenCalled();
    });

    it('still refreshes what it observed, so the row does not go stale while stopped', async () => {
        listRestoreCandidates.mockResolvedValue([row()]);
        describeServiceState.mockResolvedValue(liveStopped);

        await handleSpotGuardRestoreScan({ tenantId: TENANT, trigger: 'schedule' });

        // Being quiet on the timeline must not mean being blind: the observation still lands, which
        // is what feeds the "Stopped" badge and keeps the strategy column honest.
        expect(upsertObservedService).toHaveBeenCalledTimes(1);
        expect(upsertObservedService.mock.calls[0][0]).toMatchObject({ desiredCount: 0, runningCount: 0 });
    });

    it('keeps recording genuinely interesting scheduled skips', async () => {
        // The quiet list must stay narrow — silencing everything would rebuild the original bug,
        // where a declined restore was invisible.
        listRestoreCandidates.mockResolvedValue([row({ managementState: 'unmanaged' })]);
        describeServiceState.mockResolvedValue(liveInFallback);

        await handleSpotGuardRestoreScan({ tenantId: TENANT, trigger: 'schedule' });

        expect(skipEvents()).toHaveLength(1);
    });
});

describe('handleSpotGuardRestoreScan — the scheduled path is unchanged', () => {
    it("writes NO event for a scheduled 'nothing_to_do'", async () => {
        // The hourly scan evaluates every managed service. Recording this would add a row per
        // healthy service per hour and drown the timeline during an actual incident.
        listRestoreCandidates.mockResolvedValue([row({ restorePending: false })]);
        describeServiceState.mockResolvedValue(liveOnSpot);

        await handleSpotGuardRestoreScan({ tenantId: TENANT, trigger: 'schedule' });

        expect(writeEvent).not.toHaveBeenCalled();
    });

    it('still records an interesting scheduled skip, as backoff_skip', async () => {
        listRestoreCandidates.mockResolvedValue([
            row({ backoffUntil: new Date(Date.now() + 3_600_000) }),
        ]);
        describeServiceState.mockResolvedValue(liveInFallback);

        // force omitted, so the backoff gate applies.
        await handleSpotGuardRestoreScan({ tenantId: TENANT, trigger: 'schedule' });

        expect(skipEvents()).toHaveLength(1);
        expect(skipEvents()[0].eventType).toBe('backoff_skip');
        expect(updateCapacityProvider).not.toHaveBeenCalled();
    });
});

describe('handleSpotGuardRestoreScan — a real restore still works', () => {
    it('updates the strategy and notifies on success', async () => {
        listRestoreCandidates.mockResolvedValue([row()]);
        describeServiceState.mockResolvedValue(liveInFallback);

        await handleSpotGuardRestoreScan({ tenantId: TENANT, trigger: 'manual', force: true });

        expect(updateCapacityProvider).toHaveBeenCalledTimes(1);
        // Restores to the SAVED baseline, not a hardcoded weight — the bug-6/11 fix.
        expect(updateCapacityProvider.mock.calls[0][3]).toEqual(strategy(1, 0));
        expect(recordRestoreSuccess).toHaveBeenCalledTimes(1);
        const kinds = notify.mock.calls.map((c) => c[0].eventType);
        expect(kinds).toContain('restore_attempted');
        expect(kinds).toContain('restore_succeeded');
        expect(writeEvent).not.toHaveBeenCalled(); // success path notifies, it does not skip
    });

    it('does nothing when there are no candidates', async () => {
        listRestoreCandidates.mockResolvedValue([]);
        await handleSpotGuardRestoreScan({ tenantId: TENANT, trigger: 'manual', force: true });
        expect(createSpokeClients).not.toHaveBeenCalled();
        expect(writeEvent).not.toHaveBeenCalled();
    });
});

/**
 * The registry must not be left describing the world as it was BEFORE the restore.
 *
 * upsertObservedService runs first and records the pre-restore strategy, because the engine needs
 * the live value to decide. Nothing used to re-record it afterwards, so observedStrategy sat one
 * action behind until some later scan happened to re-observe without acting. Two sbx services were
 * found rendering the exact inverse of their live AWS strategy because of this, and the managed
 * "Capacity" dialog seeds its percentage from that same field — so a service deliberately parked in
 * fallback offered a pre-filled "100% Spot" that would undo the fallback in one click.
 */
describe('handleSpotGuardRestoreScan — observedStrategy after the mutation', () => {
    it('records the strategy it just applied', async () => {
        listRestoreCandidates.mockResolvedValue([row()]);
        describeServiceState.mockResolvedValue(liveInFallback);

        await handleSpotGuardRestoreScan({ tenantId: TENANT, trigger: 'manual', force: true });

        expect(recordAppliedStrategy).toHaveBeenCalledTimes(1);
        expect(recordAppliedStrategy.mock.calls[0][0]).toEqual({
            tenantId: TENANT,
            serviceId: 'svc-1',
            appliedStrategy: strategy(1, 0),
        });
    });

    it('records the SAME strategy it sent to AWS, never the pre-restore one', async () => {
        listRestoreCandidates.mockResolvedValue([row()]);
        describeServiceState.mockResolvedValue(liveInFallback);

        await handleSpotGuardRestoreScan({ tenantId: TENANT, trigger: 'manual', force: true });

        // The whole bug in one assertion: what we persist must equal what we applied.
        expect(recordAppliedStrategy.mock.calls[0][0].appliedStrategy).toEqual(
            updateCapacityProvider.mock.calls[0][3],
        );
        // ...and must NOT be the fallback strategy the pre-mutation read saw.
        expect(recordAppliedStrategy.mock.calls[0][0].appliedStrategy).not.toEqual(strategy(0, 10));
    });

    it('writes it AFTER UpdateService, so a throwing UpdateService leaves the row untouched', async () => {
        listRestoreCandidates.mockResolvedValue([row()]);
        describeServiceState.mockResolvedValue(liveInFallback);
        updateCapacityProvider.mockRejectedValueOnce(new Error('AccessDeniedException'));

        await handleSpotGuardRestoreScan({ tenantId: TENANT, trigger: 'manual', force: true }).catch(() => {});

        // Claiming the applied strategy when the API call failed would be worse than stale.
        expect(recordAppliedStrategy).not.toHaveBeenCalled();
    });

    it('does not touch it on a skip — nothing was applied', async () => {
        // restorePending: false as well as already-on-Spot; with restore debt outstanding the
        // engine acts regardless of live state, which is the correct behaviour and not a skip.
        listRestoreCandidates.mockResolvedValue([row({ restorePending: false })]);
        describeServiceState.mockResolvedValue(liveOnSpot); // already on Spot => nothing_to_do

        await handleSpotGuardRestoreScan({ tenantId: TENANT, trigger: 'manual', force: true });

        expect(updateCapacityProvider).not.toHaveBeenCalled();
        expect(recordAppliedStrategy).not.toHaveBeenCalled();
    });

    it('leaves capacityState to the task observer', async () => {
        // A strategy change does not move already-running tasks, so the tasks may still be on the
        // old provider. Asserting the shape of the call keeps a future edit from adding it here.
        listRestoreCandidates.mockResolvedValue([row()]);
        describeServiceState.mockResolvedValue(liveInFallback);

        await handleSpotGuardRestoreScan({ tenantId: TENANT, trigger: 'manual', force: true });

        expect(Object.keys(recordAppliedStrategy.mock.calls[0][0])).toEqual([
            'tenantId',
            'serviceId',
            'appliedStrategy',
        ]);
    });
});
