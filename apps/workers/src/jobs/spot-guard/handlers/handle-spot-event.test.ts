// workers/src/jobs/spot-guard/handlers/handle-spot-event.test.ts
//
// This handler owns the safety-critical half of Spot Guard — the path that takes a customer's
// service OFF Spot when capacity runs out — and had no test at all. That gap is not theoretical:
// it is how `observedStrategy` came to be written before the mutation and never after, which put
// two sbx services on screen showing the exact inverse of their live AWS strategy, and left the
// "Capacity" dialog offering a pre-filled "100% Spot" for a service deliberately parked in
// fallback.
//
// What these tests pin:
//   * routing — which detail-types reach which handler, and which are ignored;
//   * the mutation gates, in order: service must exist, the engine must say apply_fallback, and
//     the per-minute claim must be won. Any of them failing must leave AWS untouched;
//   * the strategy actually sent to UpdateService, and that the registry records THAT value
//     rather than the pre-fallback one it read to make the decision;
//   * multi-tenant fan-out — every owning tenant gets its own registry row updated and its own
//     timeline event, from one AWS mutation;
//   * the backoff is armed even when the fallback is skipped (the restore-thrashing fix).
//
// The engine is deliberately NOT mocked, matching handle-restore-scan.test.ts: it is pure, so
// driving it with real live-state shapes exercises the same gate ordering production does.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CapacityProviderStrategyItem } from '../types.js';

const {
    authorizeEvent,
    upsertObservedService,
    findService,
    recordFallback,
    recordAppliedStrategy,
    recordInterruption,
    claimInterruptionHandling,
    armBackoffOnly,
    claimAction,
    writeEvent,
    openSession,
    closeSession,
    createSpokeClients,
    describeServiceState,
    preDrainTaskFromAlb,
    updateCapacityProvider,
    enforceDeregistrationDelay,
    notify,
} = vi.hoisted(() => ({
    authorizeEvent: vi.fn(),
    upsertObservedService: vi.fn(),
    findService: vi.fn(),
    recordFallback: vi.fn(),
    recordAppliedStrategy: vi.fn(),
    recordInterruption: vi.fn(),
    claimInterruptionHandling: vi.fn(),
    armBackoffOnly: vi.fn(),
    claimAction: vi.fn(),
    writeEvent: vi.fn(),
    openSession: vi.fn(),
    closeSession: vi.fn(),
    createSpokeClients: vi.fn(),
    describeServiceState: vi.fn(),
    preDrainTaskFromAlb: vi.fn(),
    updateCapacityProvider: vi.fn(),
    enforceDeregistrationDelay: vi.fn(),
    notify: vi.fn(),
}));

vi.mock('../services/account-resolver.js', async () => {
    const actual = await vi.importActual<typeof import('../services/account-resolver.js')>(
        '../services/account-resolver.js',
    );
    return { ...actual, authorizeEvent };
});
vi.mock('../services/db-writer.js', async () => {
    const actual = await vi.importActual<typeof import('../services/db-writer.js')>('../services/db-writer.js');
    return {
        ...actual,
        upsertObservedService,
        findService,
        recordFallback,
        recordAppliedStrategy,
        recordInterruption,
        claimInterruptionHandling,
        armBackoffOnly,
        claimAction,
        writeEvent,
        openSession,
        closeSession,
    };
});
vi.mock('../services/ecs-client.js', async () => {
    const actual = await vi.importActual<typeof import('../services/ecs-client.js')>('../services/ecs-client.js');
    return {
        ...actual,
        createSpokeClients,
        describeServiceState,
        preDrainTaskFromAlb,
        updateCapacityProvider,
        enforceDeregistrationDelay,
    };
});
vi.mock('../services/notifier.js', () => ({ notify }));

const { handleSpotGuardEvent } = await import('./handle-spot-event.js');

const ACCOUNT = '688849551607';
const REGION = 'ap-south-1';
const CLUSTER = 'stx-kyc-ekyc-ecs-fargate';
const SERVICE = 'stx-kyc-ekyc-cdu-client';
const CLUSTER_ARN = `arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/${CLUSTER}`;

const strategy = (spot: number, onDemand: number): CapacityProviderStrategyItem[] => [
    { capacityProvider: 'FARGATE_SPOT', weight: spot, base: 0 },
    { capacityProvider: 'FARGATE', weight: onDemand, base: 0 },
];

const binding = (tenantId: string) => ({
    tenantId,
    accountId: ACCOUNT,
    roleArn: `arn:aws:iam::${ACCOUNT}:role/NucleusAccess-970547372609`,
    externalId: 'ext',
    regions: [REGION],
});

/** A SERVICE_TASK_PLACEMENT_FAILURE envelope — the event that triggers a fallback. */
const placementFailure = (over: Record<string, unknown> = {}) => ({
    id: 'evt-1',
    account: ACCOUNT,
    region: REGION,
    time: new Date('2026-07-29T12:00:00Z').toISOString(),
    'detail-type': 'ECS Service Action',
    resources: [`arn:aws:ecs:${REGION}:${ACCOUNT}:service/${CLUSTER}/${SERVICE}`],
    detail: {
        eventName: 'SERVICE_TASK_PLACEMENT_FAILURE',
        clusterArn: CLUSTER_ARN,
        reason: 'RESOURCE:FARGATE_SPOT',
        ...over,
    },
});

const job = (envelope: unknown) => ({ envelope, ingestedAtMs: Date.parse('2026-07-29T12:00:05Z') });

/** Live state: on Spot, healthy, no deployment in flight — the fallback-eligible shape. */
const liveOnSpot = {
    raw: { clusterArn: CLUSTER_ARN },
    state: {
        currentStrategy: strategy(1, 0),
        desiredCount: 2,
        runningCount: 2,
        status: 'ACTIVE',
        hasLoadBalancers: false,
        deploymentInProgress: false,
    },
};

beforeEach(() => {
    vi.clearAllMocks();
    authorizeEvent.mockResolvedValue({ ok: true, bindings: [binding('t1')], acting: binding('t1') });
    createSpokeClients.mockResolvedValue({ ecs: {}, elbv2: {} });
    describeServiceState.mockResolvedValue(liveOnSpot);
    upsertObservedService.mockImplementation(async ({ tenantId }: { tenantId: string }) => `svc-${tenantId}`);
    findService.mockResolvedValue({ consecutiveFailures: 0 });
    claimAction.mockResolvedValue(true);
});

describe('handleSpotGuardEvent — routing', () => {
    it('drops an unauthorized event before touching AWS or the database', async () => {
        authorizeEvent.mockResolvedValue({ ok: false, reason: 'not_onboarded' });

        await handleSpotGuardEvent(job(placementFailure()));

        expect(createSpokeClients).not.toHaveBeenCalled();
        expect(upsertObservedService).not.toHaveBeenCalled();
    });

    it('ignores an ECS Service Action that is not a placement failure', async () => {
        await handleSpotGuardEvent(job(placementFailure({ eventName: 'SERVICE_STEADY_STATE' })));
        expect(createSpokeClients).not.toHaveBeenCalled();
    });

    it('ignores a detail-type it does not handle', async () => {
        await handleSpotGuardEvent(job({ ...placementFailure(), 'detail-type': 'ECS Container Instance State Change' }));
        expect(createSpokeClients).not.toHaveBeenCalled();
    });

    it('skips an event it cannot attribute to a service', async () => {
        // Standalone RunTask tasks land here. Not an error — there is nothing to manage.
        const envelope = { ...placementFailure(), resources: [] as string[] };
        delete (envelope.detail as Record<string, unknown>).group;

        await handleSpotGuardEvent(job(envelope));

        expect(createSpokeClients).not.toHaveBeenCalled();
    });

    it('recovers the service name from resources[] when detail.group is absent', async () => {
        await handleSpotGuardEvent(job(placementFailure()));
        expect(describeServiceState).toHaveBeenCalledWith({}, CLUSTER, SERVICE);
    });
});

describe('handleSpotGuardEvent — the gates before a fallback', () => {
    it('does not mutate when the service no longer exists', async () => {
        describeServiceState.mockResolvedValue(null);

        await handleSpotGuardEvent(job(placementFailure()));

        expect(updateCapacityProvider).not.toHaveBeenCalled();
        expect(recordAppliedStrategy).not.toHaveBeenCalled();
    });

    it('does not mutate when the service is already on On-Demand', async () => {
        // Nothing to fall back to; acting would be a no-op rolling deployment.
        describeServiceState.mockResolvedValue({
            ...liveOnSpot,
            state: { ...liveOnSpot.state, currentStrategy: strategy(0, 100) },
        });

        await handleSpotGuardEvent(job(placementFailure()));

        expect(updateCapacityProvider).not.toHaveBeenCalled();
        const kinds = writeEvent.mock.calls.map((c) => c[0].eventType);
        expect(kinds).toContain('backoff_skip');
    });

    it('does not mutate while a deployment is already in flight', async () => {
        describeServiceState.mockResolvedValue({
            ...liveOnSpot,
            state: { ...liveOnSpot.state, deploymentInProgress: true },
        });

        await handleSpotGuardEvent(job(placementFailure()));

        expect(updateCapacityProvider).not.toHaveBeenCalled();
        expect(writeEvent.mock.calls.map((c) => c[0].eventType)).toContain('governance_skip');
    });

    it('does not mutate when another replica already claimed this minute', async () => {
        claimAction.mockResolvedValue(false);

        await handleSpotGuardEvent(job(placementFailure()));

        expect(updateCapacityProvider).not.toHaveBeenCalled();
        expect(recordAppliedStrategy).not.toHaveBeenCalled();
    });

    it('only ever writes eventTypes the CHECK constraint allows', async () => {
        describeServiceState.mockResolvedValue({
            ...liveOnSpot,
            state: { ...liveOnSpot.state, deploymentInProgress: true },
        });

        await handleSpotGuardEvent(job(placementFailure()));

        for (const c of writeEvent.mock.calls) {
            expect(['governance_skip', 'backoff_skip']).toContain(c[0].eventType);
        }
    });
});

describe('handleSpotGuardEvent — a real fallback', () => {
    it('sends On-Demand-only to UpdateService', async () => {
        await handleSpotGuardEvent(job(placementFailure()));

        expect(updateCapacityProvider).toHaveBeenCalledTimes(1);
        const applied = updateCapacityProvider.mock.calls[0][3] as CapacityProviderStrategyItem[];
        // Spot must be zero-weighted; On-Demand must carry the traffic.
        const spot = applied.filter((c) => /spot/i.test(c.capacityProvider)).reduce((n, c) => n + (c.weight ?? 0), 0);
        const od = applied.filter((c) => !/spot/i.test(c.capacityProvider)).reduce((n, c) => n + (c.weight ?? 0), 0);
        expect(spot).toBe(0);
        expect(od).toBeGreaterThan(0);
    });

    it('records the applied strategy, NOT the pre-fallback one it read to decide', async () => {
        // The regression this whole file exists for. The pre-mutation upsert records
        // strategy(1, 0) because the engine needs it; the row must not be left saying that.
        await handleSpotGuardEvent(job(placementFailure()));

        expect(recordAppliedStrategy).toHaveBeenCalledTimes(1);
        const recorded = recordAppliedStrategy.mock.calls[0][0];
        expect(recorded.appliedStrategy).toEqual(updateCapacityProvider.mock.calls[0][3]);
        expect(recorded.appliedStrategy).not.toEqual(strategy(1, 0));
        expect(recorded).toMatchObject({ tenantId: 't1', serviceId: 'svc-t1' });
    });

    it('records it AFTER UpdateService, so a failed API call leaves the row alone', async () => {
        updateCapacityProvider.mockRejectedValueOnce(new Error('AccessDeniedException'));

        await handleSpotGuardEvent(job(placementFailure())).catch(() => {});

        // Claiming a strategy AWS rejected would be worse than being stale.
        expect(recordAppliedStrategy).not.toHaveBeenCalled();
    });

    it('marks the restore debt and arms the backoff', async () => {
        await handleSpotGuardEvent(job(placementFailure()));

        expect(recordFallback).toHaveBeenCalledTimes(1);
        expect(recordFallback.mock.calls[0][0]).toMatchObject({ tenantId: 't1', serviceId: 'svc-t1' });
        expect(recordFallback.mock.calls[0][0].backoffUntil).toBeInstanceOf(Date);
    });

    it('emits placement_failure then fallback_applied, in that order', async () => {
        await handleSpotGuardEvent(job(placementFailure()));

        const kinds = notify.mock.calls.map((c) => c[0].eventType);
        expect(kinds).toEqual(['placement_failure', 'fallback_applied']);
        const applied = notify.mock.calls.find((c) => c[0].eventType === 'fallback_applied')![0];
        expect(applied.fromCapacity).toBe('spot');
        expect(applied.toCapacity).toBe('on_demand');
    });
});

/**
 * The console showed "Interruptions (24h) 12" while every one of the nine service rows read 0.
 *
 * Two halves of one omission. interruptionCount was the only one of the four counters nobody ever
 * wrote — fallbackCount, placementFailureCount and restoreCount all had writers — so the column was
 * structurally always zero. And this was the only notify() in the handler written without a
 * spotServiceId, so an interruption never appeared in the service's own timeline either.
 */
describe('handleSpotGuardEvent — a Spot interruption', () => {
    /** A task-state change whose stoppedReason marks it as a Spot reclaim. */
    const interruption = (over: Record<string, unknown> = {}) => ({
        id: 'evt-int-1',
        account: ACCOUNT,
        region: REGION,
        time: new Date().toISOString(),
        'detail-type': 'ECS Task State Change',
        resources: [`arn:aws:ecs:${REGION}:${ACCOUNT}:service/${CLUSTER}/${SERVICE}`],
        detail: {
            clusterArn: CLUSTER_ARN,
            group: `service:${SERVICE}`,
            taskArn: `arn:aws:ecs:${REGION}:${ACCOUNT}:task/${CLUSTER}/task-abc`,
            lastStatus: 'STOPPED',
            stopCode: 'SpotInterruption',
            stoppedReason: 'Your Spot Task was interrupted.',
            capacityProviderName: 'FARGATE_SPOT',
            ...over,
        },
    });

    beforeEach(() => {
        // false => "another replica already claimed this task", which returns before the drain.
        // The counter and the timeline event are written BEFORE that gate on purpose: the reclaim
        // happened either way and every owning tenant should see it.
        claimInterruptionHandling.mockResolvedValue(false);
        recordInterruption.mockResolvedValue('svc-t1');
    });

    it('counts the interruption against the service', async () => {
        await handleSpotGuardEvent(job(interruption()));

        expect(recordInterruption).toHaveBeenCalledTimes(1);
        expect(recordInterruption.mock.calls[0][0]).toEqual({
            tenantId: 't1',
            accountId: ACCOUNT,
            region: REGION,
            clusterName: CLUSTER,
            serviceName: SERVICE,
        });
    });

    it('links the timeline event to the service row', async () => {
        await handleSpotGuardEvent(job(interruption()));

        const event = notify.mock.calls.find((c) => c[0].eventType === 'interruption')![0];
        expect(event.spotServiceId).toBe('svc-t1');
    });

    it('still writes the event when the service has no registry row yet', async () => {
        // First ever sighting: handleTaskStateChange creates the row moments later. Unlinked is
        // better than dropped, and is what every interruption did before this change.
        recordInterruption.mockResolvedValue(null);

        await handleSpotGuardEvent(job(interruption()));

        const event = notify.mock.calls.find((c) => c[0].eventType === 'interruption')![0];
        expect(event.spotServiceId).toBeNull();
    });

    it('counts and links once per owning tenant', async () => {
        authorizeEvent.mockResolvedValue({
            ok: true,
            bindings: [binding('t1'), binding('t2')],
            acting: binding('t1'),
        });
        recordInterruption.mockImplementation(async ({ tenantId }: { tenantId: string }) => `svc-${tenantId}`);

        await handleSpotGuardEvent(job(interruption()));

        expect(recordInterruption.mock.calls.map((c) => c[0].tenantId).sort()).toEqual(['t1', 't2']);
        const events = notify.mock.calls.filter((c) => c[0].eventType === 'interruption');
        // Each tenant's event must carry ITS OWN row id, never the other tenant's.
        for (const [e] of events) expect(e.spotServiceId).toBe(`svc-${e.tenantId}`);
    });

    it('records it even when another replica already claimed the drain', async () => {
        // The accounting is not conditional on winning the claim — that gate only guards the
        // ALB pre-drain, which must happen exactly once.
        claimInterruptionHandling.mockResolvedValue(false);

        await handleSpotGuardEvent(job(interruption()));

        expect(recordInterruption).toHaveBeenCalledTimes(1);
        expect(preDrainTaskFromAlb).not.toHaveBeenCalled();
    });

    it('does not count a normal task stop as an interruption', async () => {
        // A scheduled scale-down (the nightly shutdown) stops tasks too. Counting those would
        // make the column meaningless.
        await handleSpotGuardEvent(
            job(interruption({ stopCode: 'ServiceSchedulerInitiated', stoppedReason: 'Scaling activity initiated' })),
        );

        expect(recordInterruption).not.toHaveBeenCalled();
        expect(notify.mock.calls.map((c) => c[0].eventType)).not.toContain('interruption');
    });
});

/**
 * A scale-up used to leave the console showing "Stopped" for minutes.
 *
 * This path learns capacityState from the event itself and deliberately makes no AWS call — that is
 * why it runs in-process. But it never knew desiredCount, so after a scale-up the row still said
 * zero tasks until the re-observation pass came round, and the Capacity column read "Stopped" for a
 * service that had been serving traffic for several minutes.
 *
 * The fix is gated on the CONTRADICTION — a task reaching RUNNING while our row says zero — so it
 * costs one DescribeServices per scale-up rather than one per task event.
 */
describe('handleSpotGuardEvent — a task starting while the row says stopped', () => {
    const running = (over: Record<string, unknown> = {}) => ({
        id: 'evt-run-1',
        account: ACCOUNT,
        region: REGION,
        time: new Date().toISOString(),
        'detail-type': 'ECS Task State Change',
        resources: [`arn:aws:ecs:${REGION}:${ACCOUNT}:service/${CLUSTER}/${SERVICE}`],
        detail: {
            clusterArn: CLUSTER_ARN,
            group: `service:${SERVICE}`,
            taskArn: `arn:aws:ecs:${REGION}:${ACCOUNT}:task/${CLUSTER}/task-1`,
            lastStatus: 'RUNNING',
            capacityProviderName: 'FARGATE_SPOT',
            startedAt: new Date().toISOString(),
            cpu: '512',
            memory: '1024',
            ...over,
        },
    });

    it('refreshes the counts so the row stops claiming the service is stopped', async () => {
        findService.mockResolvedValue({ capacityState: 'spot', desiredCount: 0, observedStrategy: [] });
        describeServiceState.mockResolvedValue({
            raw: { clusterArn: CLUSTER_ARN },
            state: { ...liveOnSpot.state, desiredCount: 4, runningCount: 4 },
        });

        await handleSpotGuardEvent(job(running()));

        const upsert = upsertObservedService.mock.calls.at(-1)![0];
        expect(upsert.desiredCount).toBe(4);
        expect(upsert.runningCount).toBe(4);
    });

    it('refreshes the strategy at the same time, since the response is already in hand', async () => {
        findService.mockResolvedValue({ capacityState: 'spot', desiredCount: 0, observedStrategy: strategy(0, 100) });
        describeServiceState.mockResolvedValue({
            raw: { clusterArn: CLUSTER_ARN },
            state: { ...liveOnSpot.state, currentStrategy: strategy(50, 50), desiredCount: 4, runningCount: 4 },
        });

        await handleSpotGuardEvent(job(running()));

        expect(upsertObservedService.mock.calls.at(-1)![0].observedStrategy).toEqual(strategy(50, 50));
    });

    it('makes NO AWS call when the row already knows the service is running', async () => {
        // The gate. Without it this would be one DescribeServices per task event, on a path that
        // exists precisely to avoid that.
        findService.mockResolvedValue({ capacityState: 'spot', desiredCount: 4, observedStrategy: strategy(1, 0) });

        await handleSpotGuardEvent(job(running()));

        expect(describeServiceState).not.toHaveBeenCalled();
        expect(upsertObservedService.mock.calls.at(-1)![0].desiredCount).toBeUndefined();
    });

    it('reads AWS once even when several tenants own the service', async () => {
        authorizeEvent.mockResolvedValue({
            ok: true,
            bindings: [binding('t1'), binding('t2')],
            acting: binding('t1'),
        });
        findService.mockResolvedValue({ capacityState: 'spot', desiredCount: 0, observedStrategy: [] });
        describeServiceState.mockResolvedValue({
            raw: { clusterArn: CLUSTER_ARN },
            state: { ...liveOnSpot.state, desiredCount: 2, runningCount: 2 },
        });

        await handleSpotGuardEvent(job(running()));

        expect(describeServiceState).toHaveBeenCalledTimes(1);
        expect(upsertObservedService).toHaveBeenCalledTimes(2);
    });

    it('leaves the row untouched when the AWS read fails', async () => {
        // Session accounting and the capacity transition must still land; a failed refresh only
        // means the counts stay as stale as they already were.
        findService.mockResolvedValue({ capacityState: 'spot', desiredCount: 0, observedStrategy: strategy(1, 0) });
        describeServiceState.mockRejectedValue(new Error('AccessDeniedException'));

        await handleSpotGuardEvent(job(running()));

        const upsert = upsertObservedService.mock.calls.at(-1)![0];
        expect(upsert.desiredCount).toBeUndefined();
        expect(upsert.observedStrategy).toEqual(strategy(1, 0));
        expect(openSession).toHaveBeenCalledTimes(1);
    });
});

describe('handleSpotGuardEvent — several tenants sharing one AWS account', () => {
    beforeEach(() => {
        authorizeEvent.mockResolvedValue({
            ok: true,
            bindings: [binding('t1'), binding('t2')],
            acting: binding('t1'),
        });
    });

    it('mutates AWS once but updates every tenant\'s row', async () => {
        await handleSpotGuardEvent(job(placementFailure()));

        // One service, one UpdateService — the claim is per account+service, not per tenant.
        expect(updateCapacityProvider).toHaveBeenCalledTimes(1);
        expect(recordAppliedStrategy).toHaveBeenCalledTimes(2);
        expect(recordAppliedStrategy.mock.calls.map((c) => c[0].tenantId).sort()).toEqual(['t1', 't2']);
        // Each tenant's own row id, never one tenant's id written under another's tenantId.
        for (const [{ tenantId, serviceId }] of recordAppliedStrategy.mock.calls) {
            expect(serviceId).toBe(`svc-${tenantId}`);
        }
    });

    it('notifies every tenant', async () => {
        await handleSpotGuardEvent(job(placementFailure()));

        const applied = notify.mock.calls.filter((c) => c[0].eventType === 'fallback_applied');
        expect(applied.map((c) => c[0].tenantId).sort()).toEqual(['t1', 't2']);
    });

    it('skips the strategy write for a tenant with no registry row rather than throwing', async () => {
        upsertObservedService.mockImplementation(async ({ tenantId }: { tenantId: string }) =>
            tenantId === 't1' ? 'svc-t1' : (undefined as unknown as string),
        );

        await handleSpotGuardEvent(job(placementFailure()));

        expect(recordAppliedStrategy.mock.calls.map((c) => c[0].tenantId)).toEqual(['t1']);
    });
});
