// workers/src/jobs/spot-guard/report/query.integration.test.ts
//
// Integration tests for the interval-clipping hours query against a REAL PostgreSQL.
//
// These are the tests that actually prove the two reference-implementation bugs are fixed,
// because both live entirely in SQL semantics:
//   * a midnight-spanning task must contribute to BOTH days, not land wholly on one;
//   * an in-flight task must be clipped to "now" and counted, not reported as zero.
//
//   docker compose up -d postgres
//   cd apps/workers && bun run test -- query.integration
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getPool, closePool } from '../../discovery/services/db.js';
import { queryDataQuality, queryHours } from './query.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const T = 'test-spot-guard-report';

/** Insert a session directly, bypassing the writers, so each test states its own fixture. */
async function insertSession(input: {
    taskArn: string;
    capacityType: 'spot' | 'on_demand';
    startedAt: string;
    stoppedAt?: string | null;
    orphaned?: boolean;
    interrupted?: boolean;
    serviceName?: string;
    clusterName?: string;
    region?: string;
    accountId?: string;
}) {
    const isOpen = !input.stoppedAt;
    await getPool().query(
        `INSERT INTO spot_guard_task_sessions
            (id,"tenantId","accountId",region,"clusterName","serviceName","taskArn",
             "capacityType","startedAt","stoppedAt","durationSeconds",interrupted,orphaned,"isOpen",
             "expiresAt","updatedAt")
         VALUES (gen_random_uuid()::text,$1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9::timestamptz,
                 NULL,$10,$11,$12,now() + interval '90 days',now())`,
        [
            T,
            input.accountId ?? '111111111111',
            input.region ?? 'ap-south-1',
            input.clusterName ?? 'cluster-a',
            input.serviceName ?? 'api',
            input.taskArn,
            input.capacityType,
            input.startedAt,
            input.stoppedAt ?? null,
            input.interrupted ?? false,
            input.orphaned ?? false,
            isOpen,
        ],
    );
}

const DAY20 = { from: new Date('2026-07-20T00:00:00Z'), to: new Date('2026-07-21T00:00:00Z') };
const DAY21 = { from: new Date('2026-07-21T00:00:00Z'), to: new Date('2026-07-22T00:00:00Z') };
/** Well after both fixture days, so "now" never clips these windows. */
const LATER = new Date('2026-08-01T00:00:00Z');

describe.skipIf(!HAS_DB)('hours query interval clipping (real Postgres)', () => {
    beforeAll(async () => {
        await getPool().query('SELECT 1');
    });
    afterAll(async () => {
        await getPool().query('DELETE FROM spot_guard_task_sessions WHERE "tenantId"=$1', [T]);
        await closePool();
    });
    beforeEach(async () => {
        await getPool().query('DELETE FROM spot_guard_task_sessions WHERE "tenantId"=$1', [T]);
    });

    it('sums a session fully inside the window', async () => {
        await insertSession({
            taskArn: 'task/inside',
            capacityType: 'spot',
            startedAt: '2026-07-20T10:00:00',
            stoppedAt: '2026-07-20T11:30:00',
        });
        const rows = await queryHours({ tenantId: T, ...DAY20, now: LATER });
        expect(rows).toHaveLength(1);
        expect(rows[0].seconds).toBe(5400);
        expect(rows[0].capacityType).toBe('spot');
    });

    it('SPLITS a midnight-spanning task across both days', async () => {
        // THE fix. A task running 22:00 -> 02:00 contributes 2h to the 20th and 2h to the
        // 21st. The reference keyed the row by the task's createdAt date and filed all 4h on
        // one day; switching to stoppedAt just moves all 4h to the other wrong day.
        await insertSession({
            taskArn: 'task/midnight',
            capacityType: 'spot',
            startedAt: '2026-07-20T22:00:00',
            stoppedAt: '2026-07-21T02:00:00',
        });

        const day20 = await queryHours({ tenantId: T, ...DAY20, now: LATER });
        const day21 = await queryHours({ tenantId: T, ...DAY21, now: LATER });

        expect(day20[0].seconds).toBe(2 * 3600);
        expect(day21[0].seconds).toBe(2 * 3600);
        // And the two halves sum to the real duration — no double counting, no loss.
        expect(day20[0].seconds + day21[0].seconds).toBe(4 * 3600);
    });

    it('clips a session that started before the window', async () => {
        await insertSession({
            taskArn: 'task/before',
            capacityType: 'spot',
            startedAt: '2026-07-19T20:00:00',
            stoppedAt: '2026-07-20T04:00:00',
        });
        const rows = await queryHours({ tenantId: T, ...DAY20, now: LATER });
        expect(rows[0].seconds).toBe(4 * 3600);
    });

    it('clips a session that ends after the window', async () => {
        await insertSession({
            taskArn: 'task/after',
            capacityType: 'spot',
            startedAt: '2026-07-20T21:00:00',
            stoppedAt: '2026-07-21T06:00:00',
        });
        const rows = await queryHours({ tenantId: T, ...DAY20, now: LATER });
        expect(rows[0].seconds).toBe(3 * 3600);
    });

    it('clips a session spanning the ENTIRE window to the window length', async () => {
        await insertSession({
            taskArn: 'task/spanning',
            capacityType: 'spot',
            startedAt: '2026-07-01T00:00:00',
            stoppedAt: '2026-08-01T00:00:00',
        });
        const rows = await queryHours({ tenantId: T, ...DAY20, now: LATER });
        expect(rows[0].seconds).toBe(24 * 3600);
    });

    it('COUNTS an in-flight session, clipped to now', async () => {
        // The reference summed only completed sessions, so a long-lived service that never
        // restarted reported ZERO hours and the report never matched live state.
        await insertSession({
            taskArn: 'task/inflight',
            capacityType: 'spot',
            startedAt: '2026-07-20T10:00:00',
            stoppedAt: null,
        });
        const rows = await queryHours({
            tenantId: T,
            from: DAY20.from,
            to: DAY20.to,
            now: new Date('2026-07-20T13:00:00Z'),
        });
        expect(rows[0].seconds).toBe(3 * 3600);
        expect(rows[0].inFlightSessions).toBe(1);
    });

    it('never lets the window extend past now', async () => {
        // win_end = LEAST(to, now), so a query for a full day made mid-day reports only the
        // elapsed part rather than inventing future hours.
        await insertSession({
            taskArn: 'task/nowclip',
            capacityType: 'spot',
            startedAt: '2026-07-20T00:00:00',
            stoppedAt: null,
        });
        const rows = await queryHours({
            tenantId: T,
            from: DAY20.from,
            to: DAY20.to,
            now: new Date('2026-07-20T06:00:00Z'),
        });
        expect(rows[0].seconds).toBe(6 * 3600);
    });

    it('is monotone: closing a session does not change its contribution', async () => {
        // Guards against double counting when an open session later closes.
        await insertSession({
            taskArn: 'task/monotone',
            capacityType: 'spot',
            startedAt: '2026-07-20T10:00:00',
            stoppedAt: null,
        });
        const openAt13 = await queryHours({
            tenantId: T,
            ...DAY20,
            now: new Date('2026-07-20T13:00:00Z'),
        });

        await getPool().query(
            `UPDATE spot_guard_task_sessions
                SET "stoppedAt"='2026-07-20T13:00:00'::timestamptz, "isOpen"=false
              WHERE "tenantId"=$1 AND "taskArn"='task/monotone'`,
            [T],
        );
        const closed = await queryHours({ tenantId: T, ...DAY20, now: LATER });

        expect(closed[0].seconds).toBe(openAt13[0].seconds);
    });

    it('EXCLUDES orphaned sessions from hours', async () => {
        // Data loss must stay visible rather than being counted as a zero-length session.
        await insertSession({
            taskArn: 'task/orphan',
            capacityType: 'spot',
            startedAt: '2026-07-20T10:00:00',
            stoppedAt: '2026-07-20T10:00:00',
            orphaned: true,
        });
        expect(await queryHours({ tenantId: T, ...DAY20, now: LATER })).toHaveLength(0);
    });

    it('excludes sessions entirely outside the window', async () => {
        await insertSession({
            taskArn: 'task/outside',
            capacityType: 'spot',
            startedAt: '2026-07-18T10:00:00',
            stoppedAt: '2026-07-18T11:00:00',
        });
        expect(await queryHours({ tenantId: T, ...DAY20, now: LATER })).toHaveLength(0);
    });

    it('produces no row for a zero-length overlap', async () => {
        // A task stopping exactly at the window start has no overlap and must not emit a
        // 0-second row that would show up as a phantom service in the report.
        await insertSession({
            taskArn: 'task/touching',
            capacityType: 'spot',
            startedAt: '2026-07-19T23:00:00',
            stoppedAt: '2026-07-20T00:00:00',
        });
        expect(await queryHours({ tenantId: T, ...DAY20, now: LATER })).toHaveLength(0);
    });

    it('splits one service into separate spot and on_demand rows', async () => {
        await insertSession({
            taskArn: 'task/s1',
            capacityType: 'spot',
            startedAt: '2026-07-20T01:00:00',
            stoppedAt: '2026-07-20T03:00:00',
        });
        await insertSession({
            taskArn: 'task/o1',
            capacityType: 'on_demand',
            startedAt: '2026-07-20T04:00:00',
            stoppedAt: '2026-07-20T05:00:00',
        });
        const rows = await queryHours({ tenantId: T, ...DAY20, now: LATER });
        expect(rows).toHaveLength(2);
        expect(rows.find((r) => r.capacityType === 'spot')!.seconds).toBe(2 * 3600);
        expect(rows.find((r) => r.capacityType === 'on_demand')!.seconds).toBe(3600);
    });

    it('groups concurrent tasks of one service into a single summed row', async () => {
        // Two tasks running the same hour is 2 task-hours, not 1 — this is capacity, not
        // wall-clock.
        await insertSession({ taskArn: 'task/c1', capacityType: 'spot', startedAt: '2026-07-20T10:00:00', stoppedAt: '2026-07-20T11:00:00' });
        await insertSession({ taskArn: 'task/c2', capacityType: 'spot', startedAt: '2026-07-20T10:00:00', stoppedAt: '2026-07-20T11:00:00' });
        const rows = await queryHours({ tenantId: T, ...DAY20, now: LATER });
        expect(rows).toHaveLength(1);
        expect(rows[0].seconds).toBe(2 * 3600);
        expect(rows[0].sessions).toBe(2);
    });

    it('isolates tenants', async () => {
        await insertSession({ taskArn: 'task/mine', capacityType: 'spot', startedAt: '2026-07-20T10:00:00', stoppedAt: '2026-07-20T11:00:00' });
        await getPool().query(
            `INSERT INTO spot_guard_task_sessions
                (id,"tenantId","accountId",region,"clusterName","serviceName","taskArn","capacityType",
                 "startedAt","stoppedAt",interrupted,orphaned,"isOpen","expiresAt","updatedAt")
             VALUES (gen_random_uuid()::text,'other-tenant','111111111111','ap-south-1','cluster-a','api',
                     'task/theirs','spot','2026-07-20T10:00:00'::timestamptz,'2026-07-20T20:00:00'::timestamptz,
                     false,false,false,now() + interval '90 days',now())`,
        );
        try {
            const rows = await queryHours({ tenantId: T, ...DAY20, now: LATER });
            expect(rows).toHaveLength(1);
            expect(rows[0].seconds).toBe(3600);
        } finally {
            await getPool().query(`DELETE FROM spot_guard_task_sessions WHERE "tenantId"='other-tenant'`);
        }
    });

    it('counts interruptions per group', async () => {
        await insertSession({ taskArn: 'task/i1', capacityType: 'spot', startedAt: '2026-07-20T10:00:00', stoppedAt: '2026-07-20T11:00:00', interrupted: true });
        await insertSession({ taskArn: 'task/i2', capacityType: 'spot', startedAt: '2026-07-20T11:00:00', stoppedAt: '2026-07-20T12:00:00' });
        const rows = await queryHours({ tenantId: T, ...DAY20, now: LATER });
        expect(rows[0].interruptions).toBe(1);
        expect(rows[0].sessions).toBe(2);
    });

    it('returns numbers, not the strings pg gives for SUM/COUNT', async () => {
        await insertSession({ taskArn: 'task/types', capacityType: 'spot', startedAt: '2026-07-20T10:00:00', stoppedAt: '2026-07-20T11:00:00' });
        const rows = await queryHours({ tenantId: T, ...DAY20, now: LATER });
        expect(typeof rows[0].seconds).toBe('number');
        expect(typeof rows[0].sessions).toBe('number');
    });
});

describe.skipIf(!HAS_DB)('data quality counts (real Postgres)', () => {
    beforeAll(async () => {
        await getPool().query('SELECT 1');
    });
    afterAll(async () => {
        await getPool().query('DELETE FROM spot_guard_task_sessions WHERE "tenantId"=$1', [T]);
        await closePool();
    });
    beforeEach(async () => {
        await getPool().query('DELETE FROM spot_guard_task_sessions WHERE "tenantId"=$1', [T]);
    });

    it('counts orphans and stale-open sessions separately', async () => {
        await insertSession({ taskArn: 'task/q-orphan', capacityType: 'spot', startedAt: '2026-07-20T10:00:00', stoppedAt: '2026-07-20T10:00:00', orphaned: true });
        // Open and started well over 7 days before "now" — the signature of a dropped
        // STOPPED event, which would otherwise inflate in-flight hours indefinitely.
        await insertSession({ taskArn: 'task/q-stale', capacityType: 'spot', startedAt: '2026-07-20T10:00:00', stoppedAt: null });

        const dq = await queryDataQuality({ tenantId: T, from: new Date('2026-07-01T00:00:00Z'), now: LATER });
        expect(dq.orphaned).toBe(1);
        expect(dq.staleOpen).toBe(1);
    });

    it('does not flag a recently-opened session as stale', async () => {
        await insertSession({ taskArn: 'task/q-fresh', capacityType: 'spot', startedAt: '2026-07-20T10:00:00', stoppedAt: null });
        const dq = await queryDataQuality({
            tenantId: T,
            from: new Date('2026-07-01T00:00:00Z'),
            now: new Date('2026-07-20T12:00:00Z'),
        });
        expect(dq.staleOpen).toBe(0);
    });
});
