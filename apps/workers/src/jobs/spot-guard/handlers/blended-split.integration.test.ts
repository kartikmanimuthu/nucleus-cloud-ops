// workers/src/jobs/spot-guard/handlers/blended-split.integration.test.ts
//
// Does a DELIBERATE BLEND survive a full fallback -> restore round trip?
//
//   docker compose up -d postgres
//   cd apps/workers && bun run test -- blended-split.integration
//
// A 30/70 split is now the default path for prod (nobody wants a customer-facing service at 100%
// Spot), and until this file the round trip had only ever been checked as pure-function vectors.
// The engine was covered; the PERSISTENCE was not. Everything between the two decisions is SQL:
//
//   fallback  recordFallback writes desiredStrategy as jsonb  (engine.ts:319-325 snapshots the
//             pre-fallback strategy verbatim — that snapshot IS the blend)
//   restore   listRestoreCandidates reads it back, and buildSpotFirstStrategy decides whether to
//             preserve or harden it based on isDeliberateSplit(spot > 0 && onDemand > 0)
//
// If weights or `base` come back mangled through that jsonb round trip, isDeliberateSplit stops
// firing and the restore hardens the blend into Spot-only — silently putting a service the operator
// asked to keep half On-Demand fully on Spot. That is an availability change, not a cost tweak,
// and no unit test can see it because the corruption would be in the database layer.
//
// Only AWS is stubbed. The database, both handlers and the real engine all run for real.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { CapacityProviderStrategyItem } from '../types.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);

const { createSpokeClients, describeServiceState, updateCapacityProvider, enforceDeregistrationDelay, notify } =
    vi.hoisted(() => ({
        createSpokeClients: vi.fn(),
        describeServiceState: vi.fn(),
        updateCapacityProvider: vi.fn(),
        enforceDeregistrationDelay: vi.fn(),
        notify: vi.fn(),
    }));

vi.mock('../services/ecs-client.js', async () => {
    const actual = await vi.importActual<typeof import('../services/ecs-client.js')>('../services/ecs-client.js');
    return { ...actual, createSpokeClients, describeServiceState, updateCapacityProvider, enforceDeregistrationDelay };
});
vi.mock('../services/notifier.js', () => ({ notify }));

const { getPool } = await import('../../discovery/services/db.js');
const { handleSpotGuardEvent } = await import('./handle-spot-event.js');
const { handleSpotGuardRestoreScan } = await import('./handle-restore-scan.js');

const T = 'test-spot-guard-blend';
const ACCOUNT = '222222222222';
const REGION = 'ap-south-1';
const CLUSTER = 'blend-cluster';
const SERVICE = 'blend-api';
const CLUSTER_ARN = `arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/${CLUSTER}`;

/** The blend under test: 30% Spot / 70% On-Demand, with a non-zero base to prove it survives too. */
const BLEND: CapacityProviderStrategyItem[] = [
    { capacityProvider: 'FARGATE_SPOT', weight: 30, base: 0 },
    { capacityProvider: 'FARGATE', weight: 70, base: 1 },
];

const liveState = (strategy: CapacityProviderStrategyItem[]) => ({
    raw: { clusterArn: CLUSTER_ARN },
    state: {
        currentStrategy: strategy,
        desiredCount: 4,
        runningCount: 4,
        status: 'ACTIVE',
        hasLoadBalancers: false,
        deploymentInProgress: false,
    },
});

const placementFailureEvent = {
    id: 'blend-evt-1',
    account: ACCOUNT,
    region: REGION,
    time: new Date().toISOString(),
    'detail-type': 'ECS Service Action',
    resources: [`arn:aws:ecs:${REGION}:${ACCOUNT}:service/${CLUSTER}/${SERVICE}`],
    detail: { eventName: 'SERVICE_TASK_PLACEMENT_FAILURE', clusterArn: CLUSTER_ARN, reason: 'RESOURCE:FARGATE_SPOT' },
};

async function row() {
    const { rows } = await getPool().query(
        `SELECT "desiredStrategy", "observedStrategy", "capacityState", "restorePending",
                "backoffUntil", "fallbackCount", "restoreCount"
           FROM spot_guard_services
          WHERE "tenantId" = $1 AND "serviceName" = $2`,
        [T, SERVICE],
    );
    return rows[0];
}

async function seed() {
    await getPool().query(
        `INSERT INTO accounts (id, "tenantId", "accountId", name, "roleArn", "externalId", regions,
                               active, "spotAutomationEnabled", "updatedAt")
         VALUES ($1, $2, $3, 'blend test', $4, 'ext-blend', ARRAY[$5], true, true, now())
         ON CONFLICT (id) DO NOTHING`,
        [`acct-${T}`, T, ACCOUNT, `arn:aws:iam::${ACCOUNT}:role/NucleusAccess-hub`, REGION],
    );
    await getPool().query(
        `INSERT INTO spot_guard_services
           (id, "tenantId", "accountId", region, "clusterName", "serviceName", "clusterArn",
            "desiredStrategy", "observedStrategy", "capacityState", "managementState",
            "restorePending", "desiredCount", "runningCount", "serviceStatus", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $8::jsonb, 'mixed', 'managed',
                 false, 4, 4, 'ACTIVE', now())`,
        [`svc-${T}`, T, ACCOUNT, REGION, CLUSTER, SERVICE, CLUSTER_ARN, JSON.stringify(BLEND)],
    );
}

async function wipe() {
    await getPool().query('DELETE FROM spot_guard_events WHERE "tenantId"=$1', [T]);
    await getPool().query('DELETE FROM spot_guard_services WHERE "tenantId"=$1', [T]);
    await getPool().query('DELETE FROM spot_guard_actions WHERE "accountId"=$1', [ACCOUNT]);
    await getPool().query('DELETE FROM accounts WHERE "tenantId"=$1', [T]);
}

describe.skipIf(!HAS_DB)('a deliberate 30/70 blend survives fallback -> restore (real Postgres)', () => {
    beforeAll(async () => {
        await getPool().query('SELECT 1');
    });

    afterAll(async () => {
        await wipe();
        // Deliberately NOT closePool() — see db-writer.interruption.integration.test.ts. The pool
        // is a module singleton shared by whatever files land in the same vitest worker.
    });

    beforeEach(async () => {
        vi.clearAllMocks();
        await wipe();
        await seed();
        createSpokeClients.mockResolvedValue({ ecs: {}, elbv2: {} });
    });

    it('snapshots the blend as the restore baseline, NOT the fallback strategy', async () => {
        describeServiceState.mockResolvedValue(liveState(BLEND));

        await handleSpotGuardEvent({ envelope: placementFailureEvent, ingestedAtMs: Date.now() });

        const after = await row();
        // The one unrecoverable bug in this feature would be saving the Spot-zero fallback strategy
        // as the baseline: the hourly job would then "restore" to On-Demand forever.
        expect(after.desiredStrategy).toEqual(BLEND);
        expect(after.restorePending).toBe(true);
        expect(after.capacityState).not.toBe('spot');
        // And AWS was told to go On-Demand-only.
        const applied = updateCapacityProvider.mock.calls[0][3] as CapacityProviderStrategyItem[];
        expect(applied.find((c) => /spot/i.test(c.capacityProvider))?.weight).toBe(0);
    });

    it('restores the blend EXACTLY, rather than hardening it to Spot-only', async () => {
        // 1. Fall back.
        describeServiceState.mockResolvedValue(liveState(BLEND));
        await handleSpotGuardEvent({ envelope: placementFailureEvent, ingestedAtMs: Date.now() });
        const fallbackApplied = updateCapacityProvider.mock.calls[0][3] as CapacityProviderStrategyItem[];

        // 2. Restore, with AWS now reporting the fallback state the previous step applied.
        updateCapacityProvider.mockClear();
        describeServiceState.mockResolvedValue(liveState(fallbackApplied));
        await handleSpotGuardRestoreScan({ tenantId: T, trigger: 'manual', force: true });

        // 3. THE ASSERTION. w30/w0 here would mean the service came back fully on Spot.
        expect(updateCapacityProvider).toHaveBeenCalledTimes(1);
        expect(updateCapacityProvider.mock.calls[0][3]).toEqual(BLEND);
    });

    it('preserves the On-Demand base through the jsonb round trip', async () => {
        // base is a separate field from weight and is what guarantees a minimum task count on
        // On-Demand. Losing it would look like a working restore while removing the floor.
        describeServiceState.mockResolvedValue(liveState(BLEND));
        await handleSpotGuardEvent({ envelope: placementFailureEvent, ingestedAtMs: Date.now() });

        const stored = (await row()).desiredStrategy as CapacityProviderStrategyItem[];
        expect(stored.find((c) => c.capacityProvider === 'FARGATE')?.base).toBe(1);
    });

    it('leaves the baseline untouched by the restore itself', async () => {
        describeServiceState.mockResolvedValue(liveState(BLEND));
        await handleSpotGuardEvent({ envelope: placementFailureEvent, ingestedAtMs: Date.now() });
        const fallbackApplied = updateCapacityProvider.mock.calls[0][3] as CapacityProviderStrategyItem[];

        describeServiceState.mockResolvedValue(liveState(fallbackApplied));
        await handleSpotGuardRestoreScan({ tenantId: T, trigger: 'manual', force: true });

        // persistDesiredStrategy is false when the hardened strategy equals the stored one, so a
        // successful blend restore must not rewrite the baseline.
        expect((await row()).desiredStrategy).toEqual(BLEND);
    });

    it('records the applied strategy as observed, both ways round', async () => {
        // The staleness fix, exercised through real SQL rather than a mocked writer.
        describeServiceState.mockResolvedValue(liveState(BLEND));
        await handleSpotGuardEvent({ envelope: placementFailureEvent, ingestedAtMs: Date.now() });
        const fallbackApplied = updateCapacityProvider.mock.calls[0][3] as CapacityProviderStrategyItem[];
        expect((await row()).observedStrategy).toEqual(fallbackApplied);

        describeServiceState.mockResolvedValue(liveState(fallbackApplied));
        await handleSpotGuardRestoreScan({ tenantId: T, trigger: 'manual', force: true });
        expect((await row()).observedStrategy).toEqual(BLEND);
    });

    it('clears the restore debt and the backoff on success', async () => {
        describeServiceState.mockResolvedValue(liveState(BLEND));
        await handleSpotGuardEvent({ envelope: placementFailureEvent, ingestedAtMs: Date.now() });
        expect((await row()).backoffUntil).not.toBeNull();

        const fallbackApplied = updateCapacityProvider.mock.calls[0][3] as CapacityProviderStrategyItem[];
        describeServiceState.mockResolvedValue(liveState(fallbackApplied));
        await handleSpotGuardRestoreScan({ tenantId: T, trigger: 'manual', force: true });

        const after = await row();
        expect(after.restorePending).toBe(false);
        expect(after.backoffUntil).toBeNull();
        expect(after.fallbackCount).toBe(1);
        expect(after.restoreCount).toBe(1);
    });

    it('by contrast, a Spot-first baseline IS hardened to Spot-only', async () => {
        // The control. Preserving a blend must not accidentally disable hardening for the classic
        // baseline, where zeroing On-Demand is the correct and intended behaviour.
        const spotFirst: CapacityProviderStrategyItem[] = [
            { capacityProvider: 'FARGATE_SPOT', weight: 1, base: 0 },
            { capacityProvider: 'FARGATE', weight: 0, base: 0 },
        ];
        await getPool().query(
            `UPDATE spot_guard_services SET "desiredStrategy" = $2::jsonb, "restorePending" = true
              WHERE "tenantId" = $1`,
            [T, JSON.stringify(spotFirst)],
        );
        describeServiceState.mockResolvedValue(
            liveState([
                { capacityProvider: 'FARGATE_SPOT', weight: 0, base: 0 },
                { capacityProvider: 'FARGATE', weight: 100, base: 0 },
            ]),
        );

        await handleSpotGuardRestoreScan({ tenantId: T, trigger: 'manual', force: true });

        const applied = updateCapacityProvider.mock.calls[0][3] as CapacityProviderStrategyItem[];
        expect(applied.find((c) => /spot/i.test(c.capacityProvider))?.weight).toBeGreaterThan(0);
        expect(applied.find((c) => c.capacityProvider === 'FARGATE')?.weight).toBe(0);
    });
});
