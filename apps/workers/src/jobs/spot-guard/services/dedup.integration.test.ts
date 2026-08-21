// workers/src/jobs/spot-guard/services/dedup.integration.test.ts
//
// Integration tests for the alert-dedup primitive against a REAL PostgreSQL.
//
// These cannot be meaningfully mocked: the properties under test are row-level locking
// under concurrency and the exact semantics of statement_timestamp() inside
// ON CONFLICT DO UPDATE. A mock would assert my own assumptions back at me.
//
//   docker compose up -d postgres
//   cd apps/workers && bun run test -- dedup.integration
//
// Skips itself when DATABASE_URL is unset so it never breaks CI that has no database.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getPool, closePool } from '../../discovery/services/db.js';
import { buildDedupKey, claimAlertWindow } from './dedup.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);
const TENANT_A = 'test-spot-guard-dedup-a';
const TENANT_B = 'test-spot-guard-dedup-b';

const key = (name: string) =>
    buildDedupKey({
        alertType: 'interruption',
        accountId: '111111111111',
        region: 'ap-south-1',
        clusterName: 'cluster-1',
        serviceName: name,
    });

describe.skipIf(!HAS_DB)('claimAlertWindow (real Postgres)', () => {
    beforeAll(async () => {
        await getPool().query('SELECT 1');
    });

    afterAll(async () => {
        await getPool().query('DELETE FROM spot_guard_alert_dedup WHERE "tenantId" = ANY($1)', [[TENANT_A, TENANT_B]]);
        await closePool();
    });

    beforeEach(async () => {
        await getPool().query('DELETE FROM spot_guard_alert_dedup WHERE "tenantId" = ANY($1)', [[TENANT_A, TENANT_B]]);
    });

    it('grants the first claim and suppresses the second inside the window', async () => {
        const k = key('svc-basic');
        const first = await claimAlertWindow({ tenantId: TENANT_A, dedupKey: k, alertType: 'interruption' });
        const second = await claimAlertWindow({ tenantId: TENANT_A, dedupKey: k, alertType: 'interruption' });

        expect(first.granted).toBe(true);
        expect(second.granted).toBe(false);
        expect(second.suppressedCount).toBe(1);
    });

    it('counts every suppressed alert in the window', async () => {
        const k = key('svc-count');
        await claimAlertWindow({ tenantId: TENANT_A, dedupKey: k, alertType: 'interruption' });
        for (let i = 0; i < 3; i++) {
            await claimAlertWindow({ tenantId: TENANT_A, dedupKey: k, alertType: 'interruption' });
        }
        const { rows } = await getPool().query<{ hitCount: number; suppressedCount: number }>(
            'SELECT "hitCount", "suppressedCount" FROM spot_guard_alert_dedup WHERE "tenantId"=$1 AND "dedupKey"=$2',
            [TENANT_A, k],
        );
        expect(Number(rows[0].hitCount)).toBe(4);
        expect(Number(rows[0].suppressedCount)).toBe(3);
    });

    it('RE-PERMITS the alert once the window expires', async () => {
        // The property a plain unique index breaks: after expiry the row still exists,
        // so a naive ON CONFLICT DO NOTHING would suppress the alert forever instead of
        // for windowSeconds. This is the single most important behaviour here.
        const k = key('svc-expiry');
        const first = await claimAlertWindow({
            tenantId: TENANT_A,
            dedupKey: k,
            alertType: 'interruption',
            windowSeconds: 1,
        });
        expect(first.granted).toBe(true);

        // Expire it deterministically rather than sleeping.
        await getPool().query(
            `UPDATE spot_guard_alert_dedup SET "expiresAt" = statement_timestamp() - interval '1 second'
             WHERE "tenantId"=$1 AND "dedupKey"=$2`,
            [TENANT_A, k],
        );

        const afterExpiry = await claimAlertWindow({
            tenantId: TENANT_A,
            dedupKey: k,
            alertType: 'interruption',
            windowSeconds: 1,
        });
        expect(afterExpiry.granted).toBe(true);
        // The reclaim resets the suppression counter for the new window.
        expect(afterExpiry.suppressedCount).toBe(0);
    });

    it('is race-free: exactly ONE of many concurrent claims is granted', async () => {
        // Simulates both workers replicas (and pg-boss retries) hitting one key at once.
        const k = key('svc-race');
        const results = await Promise.all(
            Array.from({ length: 12 }, () =>
                claimAlertWindow({ tenantId: TENANT_A, dedupKey: k, alertType: 'interruption' }),
            ),
        );
        expect(results.filter((r) => r.granted)).toHaveLength(1);
        expect(results.filter((r) => !r.granted)).toHaveLength(11);
    });

    it('isolates tenants: the same dedupKey grants independently per tenant', async () => {
        const k = key('svc-shared-name');
        const a = await claimAlertWindow({ tenantId: TENANT_A, dedupKey: k, alertType: 'interruption' });
        const b = await claimAlertWindow({ tenantId: TENANT_B, dedupKey: k, alertType: 'interruption' });
        expect(a.granted).toBe(true);
        expect(b.granted).toBe(true);
    });

    it('does not let two clusters in one account collide (the reference bug)', async () => {
        // The old key was TYPE#account#service, so these two would have shared a window
        // and silently suppressed each other.
        const common = { alertType: 'interruption' as const, accountId: '111111111111', region: 'ap-south-1', serviceName: 'api' };
        const k1 = buildDedupKey({ ...common, clusterName: 'cluster-a' });
        const k2 = buildDedupKey({ ...common, clusterName: 'cluster-b' });
        expect(k1).not.toBe(k2);

        expect((await claimAlertWindow({ tenantId: TENANT_A, dedupKey: k1, alertType: 'interruption' })).granted).toBe(true);
        expect((await claimAlertWindow({ tenantId: TENANT_A, dedupKey: k2, alertType: 'interruption' })).granted).toBe(true);
    });

    it('does not let two regions collide either', async () => {
        const common = { alertType: 'interruption' as const, accountId: '111111111111', clusterName: 'c', serviceName: 'api' };
        const k1 = buildDedupKey({ ...common, region: 'ap-south-1' });
        const k2 = buildDedupKey({ ...common, region: 'us-east-1' });
        expect((await claimAlertWindow({ tenantId: TENANT_A, dedupKey: k1, alertType: 'interruption' })).granted).toBe(true);
        expect((await claimAlertWindow({ tenantId: TENANT_A, dedupKey: k2, alertType: 'interruption' })).granted).toBe(true);
    });

    it('never dedups a zero-window alert type and writes no row', async () => {
        const k = buildDedupKey({
            alertType: 'spot_enabled',
            accountId: '111111111111',
            region: 'ap-south-1',
            clusterName: 'c',
            serviceName: 's',
        });
        for (let i = 0; i < 3; i++) {
            expect((await claimAlertWindow({ tenantId: TENANT_A, dedupKey: k, alertType: 'spot_enabled' })).granted).toBe(
                true,
            );
        }
        const { rows } = await getPool().query('SELECT 1 FROM spot_guard_alert_dedup WHERE "tenantId"=$1 AND "dedupKey"=$2', [
            TENANT_A,
            k,
        ]);
        expect(rows).toHaveLength(0);
    });

    it('does not report granted when firstSeenAt equals lastSeenAt inside a live window', async () => {
        // Regression for a real bug, expressed DETERMINISTICALLY.
        //
        // The bug: firstSeenAt/lastSeenAt were compared to derive `granted`, but they are
        // millisecond-precision columns, so two claims arriving inside one millisecond
        // stored the same value and EVERY claim reported granted — dedup silently did
        // nothing. `granted` now comes from the suppression counter, which has no precision
        // floor.
        //
        // An earlier version of this test raced two real claims and then asserted the
        // timestamps had collapsed. That assertion is load-dependent — under a parallel
        // full-suite run the two claims land in different milliseconds and it fails for the
        // wrong reason. So the condition is CONSTRUCTED instead: seed a row whose timestamps
        // are already equal with a live window, then claim. If `granted` were still derived
        // from timestamp equality this would wrongly return true.
        const k = key('svc-equal-timestamps');
        await getPool().query(
            `INSERT INTO spot_guard_alert_dedup
                (id,"tenantId","dedupKey","alertType","windowSeconds","firstSeenAt","lastSeenAt",
                 "hitCount","suppressedCount","expiresAt")
             VALUES (gen_random_uuid()::text,$1,$2,'interruption',300,
                     statement_timestamp(), statement_timestamp(), 1, 0,
                     statement_timestamp() + interval '300 seconds')`,
            [TENANT_A, k],
        );

        const { rows: seeded } = await getPool().query<{ same: boolean }>(
            'SELECT ("firstSeenAt" = "lastSeenAt") AS same FROM spot_guard_alert_dedup WHERE "tenantId"=$1 AND "dedupKey"=$2',
            [TENANT_A, k],
        );
        // The precondition this test exists to exercise, now guaranteed rather than hoped for.
        expect(seeded[0].same).toBe(true);

        const claim = await claimAlertWindow({ tenantId: TENANT_A, dedupKey: k, alertType: 'interruption' });
        expect(claim.granted).toBe(false);
        expect(claim.suppressedCount).toBe(1);
    });

    it('rejects an alertType outside the CHECK constraint', async () => {
        await expect(
            getPool().query(
                `INSERT INTO spot_guard_alert_dedup (id,"tenantId","dedupKey","alertType","windowSeconds","expiresAt")
                 VALUES ('x',$1,'k','not_a_real_alert',300, statement_timestamp())`,
                [TENANT_A],
            ),
        ).rejects.toThrow(/violates check constraint/);
    });
});
