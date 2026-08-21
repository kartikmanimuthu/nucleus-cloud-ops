// workers/src/jobs/spot-guard/services/db-writer.integration.test.ts
//
// Integration tests against a REAL PostgreSQL for the writers whose correctness lives in
// SQL semantics rather than in TypeScript: out-of-order session healing, the two
// exactly-once claims, and event idempotency. Mocking these would only assert my own
// assumptions back at me.
//
//   docker compose up -d postgres
//   cd apps/workers && bun run test -- db-writer.integration
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getPool, closePool } from '../../discovery/services/db.js';
import {
    claimAction,
    claimInterruptionHandling,
    closeSession,
    openSession,
    writeEvent,
} from './db-writer.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const T = 'test-spot-guard-dbw';

const svc = {
    tenantId: T,
    accountId: '111111111111',
    region: 'ap-south-1',
    clusterName: 'cluster-1',
    serviceName: 'api',
};

const CLUSTER_ARN = 'arn:aws:ecs:ap-south-1:111111111111:cluster/cluster-1';

async function sessionRow(taskArn: string) {
    const { rows } = await getPool().query(
        `SELECT "startedAt","stoppedAt","durationSeconds","reportDate","isOpen",orphaned,
                interrupted,"interruptionHandledAt","expiresAt","capacityType"
           FROM spot_guard_task_sessions WHERE "tenantId"=$1 AND "taskArn"=$2`,
        [T, taskArn],
    );
    return rows[0];
}

describe.skipIf(!HAS_DB)('spot-guard db-writer (real Postgres)', () => {
    beforeAll(async () => {
        await getPool().query('SELECT 1');
    });

    afterAll(async () => {
        await getPool().query('DELETE FROM spot_guard_task_sessions WHERE "tenantId"=$1', [T]);
        await getPool().query('DELETE FROM spot_guard_events WHERE "tenantId"=$1', [T]);
        await getPool().query('DELETE FROM spot_guard_actions WHERE "accountId"=$1', [svc.accountId]);
        await closePool();
    });

    beforeEach(async () => {
        await getPool().query('DELETE FROM spot_guard_task_sessions WHERE "tenantId"=$1', [T]);
        await getPool().query('DELETE FROM spot_guard_events WHERE "tenantId"=$1', [T]);
        await getPool().query('DELETE FROM spot_guard_actions WHERE "accountId"=$1', [svc.accountId]);
    });

    // ── Sessions, in order ───────────────────────────────────────────────────

    it('records a normal RUNNING then STOPPED lifecycle with a numeric duration', async () => {
        const taskArn = 'arn:aws:ecs:ap-south-1:111111111111:task/cluster-1/normal';
        const started = new Date('2026-07-20T10:00:00Z');
        const stopped = new Date('2026-07-20T10:30:00Z');

        await openSession({ ...svc, taskArn, capacityType: 'spot', capacityProvider: 'FARGATE_SPOT', startedAt: started });
        let r = await sessionRow(taskArn);
        expect(r.isOpen).toBe(true);
        expect(r.stoppedAt).toBeNull();

        await closeSession({ ...svc, taskArn, capacityType: 'spot', stoppedAt: stopped, interrupted: false });
        r = await sessionRow(taskArn);
        expect(r.isOpen).toBe(false);
        // 30 minutes — a NUMBER, not a stringified float as the reference stored.
        expect(Number(r.durationSeconds)).toBe(1800);
        expect(r.orphaned).toBe(false);
        expect(r.reportDate).toBe('2026-07-20');
    });

    it('extends the TTL from the 14-day orphan window to 90-day retention on close', async () => {
        const taskArn = 'arn:aws:ecs:ap-south-1:111111111111:task/cluster-1/ttl';
        const started = new Date('2026-07-20T10:00:00Z');
        await openSession({ ...svc, taskArn, capacityType: 'spot', startedAt: started });
        const openTtl = new Date((await sessionRow(taskArn)).expiresAt).getTime();

        await closeSession({ ...svc, taskArn, capacityType: 'spot', stoppedAt: new Date('2026-07-20T10:05:00Z'), interrupted: false });
        const closedTtl = new Date((await sessionRow(taskArn)).expiresAt).getTime();

        // 14d -> 90d. Without this the orphan reaper would delete real report data.
        expect(closedTtl).toBeGreaterThan(openTtl);
        const days = (closedTtl - new Date('2026-07-20T10:05:00Z').getTime()) / 86_400_000;
        expect(Math.round(days)).toBe(90);
    });

    // ── Sessions, out of order ───────────────────────────────────────────────

    it('marks a STOPPED-with-no-RUNNING session orphaned, excluded from hours', async () => {
        // EventBridge gives no ordering guarantee, and the open row may also have been
        // reaped. Counting this as a zero-length session would hide data loss.
        const taskArn = 'arn:aws:ecs:ap-south-1:111111111111:task/cluster-1/orphan';
        await closeSession({
            ...svc, taskArn, capacityType: 'on_demand',
            stoppedAt: new Date('2026-07-20T12:00:00Z'), interrupted: false,
        });
        const r = await sessionRow(taskArn);
        expect(r.orphaned).toBe(true);
        expect(r.isOpen).toBe(false);
        expect(Number(r.durationSeconds ?? 0)).toBe(0);
    });

    it('HEALS an orphaned session when the late RUNNING finally arrives', async () => {
        const taskArn = 'arn:aws:ecs:ap-south-1:111111111111:task/cluster-1/heal';
        const started = new Date('2026-07-20T09:00:00Z');
        const stopped = new Date('2026-07-20T09:45:00Z');

        // STOPPED first...
        await closeSession({ ...svc, taskArn, capacityType: 'spot', stoppedAt: stopped, interrupted: false });
        expect((await sessionRow(taskArn)).orphaned).toBe(true);

        // ...then the real RUNNING.
        await openSession({ ...svc, taskArn, capacityType: 'spot', startedAt: started });

        const r = await sessionRow(taskArn);
        expect(r.orphaned).toBe(false);
        expect(new Date(r.startedAt).toISOString()).toBe(started.toISOString());
        // Duration recomputed from the real start: 45 minutes.
        expect(Number(r.durationSeconds)).toBe(2700);
        // Still closed — a late RUNNING must not reopen a finished session.
        expect(r.isOpen).toBe(false);
    });

    it('keeps the earliest startedAt when RUNNING is delivered twice', async () => {
        const taskArn = 'arn:aws:ecs:ap-south-1:111111111111:task/cluster-1/dupe-start';
        await openSession({ ...svc, taskArn, capacityType: 'spot', startedAt: new Date('2026-07-20T10:00:00Z') });
        await openSession({ ...svc, taskArn, capacityType: 'spot', startedAt: new Date('2026-07-20T10:05:00Z') });
        expect(new Date((await sessionRow(taskArn)).startedAt).toISOString()).toBe('2026-07-20T10:00:00.000Z');
    });

    it('never produces a negative duration even if stoppedAt precedes startedAt', async () => {
        // Clock skew between ECS fields would otherwise violate the DB CHECK and throw.
        const taskArn = 'arn:aws:ecs:ap-south-1:111111111111:task/cluster-1/skew';
        await openSession({ ...svc, taskArn, capacityType: 'spot', startedAt: new Date('2026-07-20T10:00:00Z') });
        await closeSession({ ...svc, taskArn, capacityType: 'spot', stoppedAt: new Date('2026-07-20T09:00:00Z'), interrupted: false });
        expect(Number((await sessionRow(taskArn)).durationSeconds)).toBe(0);
    });

    it('is idempotent under duplicate STOPPED delivery', async () => {
        const taskArn = 'arn:aws:ecs:ap-south-1:111111111111:task/cluster-1/dupe-stop';
        const started = new Date('2026-07-20T10:00:00Z');
        const stopped = new Date('2026-07-20T10:10:00Z');
        await openSession({ ...svc, taskArn, capacityType: 'spot', startedAt: started });
        await closeSession({ ...svc, taskArn, capacityType: 'spot', stoppedAt: stopped, interrupted: false });
        await closeSession({ ...svc, taskArn, capacityType: 'spot', stoppedAt: stopped, interrupted: false });

        const { rows } = await getPool().query('SELECT count(*) AS n FROM spot_guard_task_sessions WHERE "tenantId"=$1 AND "taskArn"=$2', [T, taskArn]);
        expect(Number(rows[0].n)).toBe(1);
        expect(Number((await sessionRow(taskArn)).durationSeconds)).toBe(600);
    });

    it('computes reportDate in the requested timezone, from stoppedAt', async () => {
        // 23:30 UTC on the 20th is 05:00 on the 21st in IST. The reference filed sessions
        // under the task's createdAt date, which put cross-midnight tasks on the wrong day.
        const taskArn = 'arn:aws:ecs:ap-south-1:111111111111:task/cluster-1/tz';
        await openSession({ ...svc, taskArn, capacityType: 'spot', startedAt: new Date('2026-07-20T22:00:00Z') });
        await closeSession({
            ...svc, taskArn, capacityType: 'spot',
            stoppedAt: new Date('2026-07-20T23:30:00Z'), interrupted: false, timezone: 'Asia/Kolkata',
        });
        expect((await sessionRow(taskArn)).reportDate).toBe('2026-07-21');
    });

    // ── Exactly-once claims ──────────────────────────────────────────────────

    it('claims the ALB pre-drain exactly once per task, even concurrently', async () => {
        // The reference used a non-atomic GetItem-then-PutItem here, so two concurrent
        // invocations could both believe they were first and both deregister.
        const taskArn = 'arn:aws:ecs:ap-south-1:111111111111:task/cluster-1/interrupt';
        const args = { ...svc, taskArn, capacityType: 'spot' as const, observedAt: new Date('2026-07-20T10:00:00Z') };
        const results = await Promise.all(Array.from({ length: 8 }, () => claimInterruptionHandling(args)));
        expect(results.filter(Boolean)).toHaveLength(1);

        const r = await sessionRow(taskArn);
        expect(r.interrupted).toBe(true);
        expect(r.interruptionHandledAt).not.toBeNull();
        // Created without a RUNNING event, so it must not contribute hours.
        expect(r.orphaned).toBe(true);
    });

    it('claims the pre-drain on an already-open session without duplicating the row', async () => {
        const taskArn = 'arn:aws:ecs:ap-south-1:111111111111:task/cluster-1/interrupt-open';
        await openSession({ ...svc, taskArn, capacityType: 'spot', startedAt: new Date('2026-07-20T10:00:00Z') });
        expect(await claimInterruptionHandling({ ...svc, taskArn, capacityType: 'spot', observedAt: new Date() })).toBe(true);
        expect(await claimInterruptionHandling({ ...svc, taskArn, capacityType: 'spot', observedAt: new Date() })).toBe(false);

        const r = await sessionRow(taskArn);
        expect(r.interrupted).toBe(true);
        // An open session that got interrupted is still real data, not an orphan.
        expect(r.orphaned).toBe(false);
    });

    it('claims a mutation exactly once per minute window, even concurrently', async () => {
        const args = {
            accountId: svc.accountId, clusterArn: CLUSTER_ARN, serviceName: svc.serviceName,
            action: 'fallback' as const, actingTenant: T,
        };
        const results = await Promise.all(Array.from({ length: 10 }, () => claimAction(args)));
        expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('scopes the mutation claim per action, so fallback and restore do not block each other', async () => {
        const base = { accountId: svc.accountId, clusterArn: CLUSTER_ARN, serviceName: svc.serviceName, actingTenant: T };
        expect(await claimAction({ ...base, action: 'fallback' })).toBe(true);
        expect(await claimAction({ ...base, action: 'restore' })).toBe(true);
        expect(await claimAction({ ...base, action: 'fallback' })).toBe(false);
    });

    it('scopes the mutation claim per service', async () => {
        const base = { accountId: svc.accountId, clusterArn: CLUSTER_ARN, action: 'fallback' as const, actingTenant: T };
        expect(await claimAction({ ...base, serviceName: 'api' })).toBe(true);
        expect(await claimAction({ ...base, serviceName: 'worker' })).toBe(true);
    });

    it('elects ONE winner across tenants sharing an AWS account', async () => {
        // The multi-tenant case: two tenants own this account, one event resolves to
        // both, but ecs:UpdateService must fire once.
        const base = { accountId: svc.accountId, clusterArn: CLUSTER_ARN, serviceName: svc.serviceName, action: 'fallback' as const };
        const results = await Promise.all([
            claimAction({ ...base, actingTenant: 'tenant-a' }),
            claimAction({ ...base, actingTenant: 'tenant-b' }),
        ]);
        expect(results.filter(Boolean)).toHaveLength(1);
    });

    // ── Event timeline ───────────────────────────────────────────────────────

    it('writes an event and dedups a replayed sourceEventId', async () => {
        const args = {
            ...svc, eventType: 'interruption' as const, severity: 'warning' as const,
            sourceEventId: 'eb-event-1', message: 'reclaimed',
        };
        const first = await writeEvent(args);
        const second = await writeEvent(args);
        expect(first).not.toBeNull();
        expect(second).toBeNull(); // ON CONFLICT DO NOTHING
    });

    it('allows the same sourceEventId under a different eventType', async () => {
        // One inbound event can legitimately produce an interruption record AND an
        // alb_predrain record; the unique key includes eventType for that reason.
        const base = { ...svc, sourceEventId: 'eb-event-2' };
        expect(await writeEvent({ ...base, eventType: 'interruption' })).not.toBeNull();
        expect(await writeEvent({ ...base, eventType: 'alb_predrain' })).not.toBeNull();
    });

    it('does NOT dedup events with no sourceEventId', async () => {
        // NULLs are distinct in a Postgres unique index, which is what lets repeated
        // user-initiated actions each get their own timeline row.
        expect(await writeEvent({ ...svc, eventType: 'spot_enabled', actor: 'user@x' })).not.toBeNull();
        expect(await writeEvent({ ...svc, eventType: 'spot_enabled', actor: 'user@x' })).not.toBeNull();
    });

    it('rejects an eventType outside the CHECK constraint', async () => {
        await expect(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            writeEvent({ ...svc, eventType: 'not_a_real_type' as any }),
        ).rejects.toThrow(/violates check constraint/);
    });
});
