// Integration test against a real local Postgres. The settled-day logic is where
// the worst seal defect lived — a day sealed while it could still receive rows
// produces a stale seal that can NEVER be corrected (both tables reject UPDATE)
// and reads as tampering. That behaviour depends on real SQL over real dates, so
// it is tested against a database rather than mocks.
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';

function loadDatabaseUrlFromEnvFile(): void {
    if (process.env.DATABASE_URL) return;
    const envPath = resolve(import.meta.dirname, '../../../../../../.env');
    if (!existsSync(envPath)) return;
    const match = readFileSync(envPath, 'utf-8').match(/^DATABASE_URL=(.+)$/m);
    if (match) process.env.DATABASE_URL = match[1].trim();
}
loadDatabaseUrlFromEnvFile();

const TENANT = `seal-test-${Date.now()}`;
const describeIf = process.env.DATABASE_URL ? describe : describe.skip;

describeIf('daily-seal integration (real Postgres)', () => {
    let pool: Pool;

    const insertEvent = (day: string, activityId: string) =>
        pool.query(
            `INSERT INTO scaling_events ("id","tenantId","accountId","region","scope","source","activityId",
                "resourceId","scalingType","causeFingerprint","cause","startedAt","reportDateIst","capturedByRunId")
             VALUES (gen_random_uuid()::text,$1,'111111111111','ap-south-1','asg','aws_api',$2,
                'res','manual','fp','cause',$3::date + interval '4 hours',$3::date,'run')`,
            [TENANT, activityId, day]
        );

    const setWatermark = (lastPolledAt: string, gapDetected = false) =>
        pool.query(
            `INSERT INTO scaling_audit_watermarks (id,"tenantId","accountId",region,scope,"source","lastPolledAt","gapDetected","updatedAt")
             VALUES (gen_random_uuid()::text,$1,'111111111111','ap-south-1','asg','aws_api',$2::timestamptz,$3,now())
             ON CONFLICT ("tenantId","accountId",region,scope,"source")
             DO UPDATE SET "lastPolledAt"=EXCLUDED."lastPolledAt", "gapDetected"=EXCLUDED."gapDetected"`,
            [TENANT, lastPolledAt, gapDetected]
        );

    beforeAll(async () => {
        pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    });

    afterAll(async () => {
        // scaling_events rejects DELETE by design, so test rows are left behind;
        // the tenant id is unique per run so they never collide.
        await pool.query('DELETE FROM scaling_audit_watermarks WHERE "tenantId"=$1', [TENANT]).catch(() => {});
        await pool.end();
    });

    it('refuses to seal when no watermark exists — nothing has been captured to attest', async () => {
        const { sealPendingDays } = await import('./daily-seal.js');
        const r = await sealPendingDays(TENANT);
        expect(r.sealed).toEqual([]);
        expect(r.blockedReason).toBe('no_watermarks_yet');
    });

    it('refuses to seal while a gap is known — never signs an incomplete record', async () => {
        const { sealPendingDays } = await import('./daily-seal.js');
        await insertEvent('2026-07-01', `${TENANT}-a1`);
        await setWatermark('2026-08-01T00:00:00Z', true);
        const r = await sealPendingDays(TENANT);
        expect(r.sealed).toEqual([]);
        expect(r.blockedReason).toBe('gap_detected');
    });

    it('seals every settled day oldest-first, chaining each to the one before', async () => {
        const { sealPendingDays } = await import('./daily-seal.js');
        await insertEvent('2026-07-02', `${TENANT}-a2`);
        await insertEvent('2026-07-03', `${TENANT}-a3`);
        await setWatermark('2026-08-01T00:00:00Z', false); // clears the gap

        const r = await sealPendingDays(TENANT);
        // Sealing only "yesterday" was the defect: all three historical days must seal.
        expect(r.sealed).toEqual(['2026-07-01', '2026-07-02', '2026-07-03']);

        const seals = await pool.query(
            `SELECT to_char(day,'YYYY-MM-DD') d, "prevSeal", seal FROM scaling_audit_daily_seals
              WHERE "tenantId"=$1 ORDER BY day`, [TENANT]);
        expect(seals.rows[0].prevSeal).toBeNull();               // first day starts the chain
        expect(seals.rows[1].prevSeal).toBe(seals.rows[0].seal); // each links to the prior day
        expect(seals.rows[2].prevSeal).toBe(seals.rows[1].seal);
    });

    it('does NOT seal a day the slowest source has not yet polled past', async () => {
        const { sealPendingDays } = await import('./daily-seal.js');
        // A day newer than lastPolledAt is still open to inserts. Sealing it would
        // record a rowCount that later grows — an uncorrectable, false tamper signal.
        await insertEvent('2026-08-15', `${TENANT}-future`);
        const r = await sealPendingDays(TENANT);
        expect(r.sealed).not.toContain('2026-08-15');
    });

    it('is idempotent — re-running seals nothing new', async () => {
        const { sealPendingDays } = await import('./daily-seal.js');
        const r = await sealPendingDays(TENANT);
        expect(r.sealed).toEqual([]);
    });
});
