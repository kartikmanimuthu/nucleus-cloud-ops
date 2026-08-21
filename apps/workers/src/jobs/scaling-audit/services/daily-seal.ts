// workers/src/jobs/scaling-audit/services/daily-seal.ts
//
// Per-tenant, per-day chained digest over that day's ScalingEvent rows. Converts
// "append-only by convention" into a provable claim: any retroactive edit or
// deletion of a row changes rowsDigest, which breaks every subsequent link in the
// chain. Every export prints the seal it was generated from.
//
// Three defects found against live sbx data on 2026-08-05 and fixed here:
//
//  1. The seal did not bind to the TENANT. The digest was
//     sha256(prevSeal|day|rowCount|rowsDigest), so two tenants with the same day
//     and the same row set produced byte-identical seals — observed exactly, with
//     five tenants that had no events that day all sharing seal 2b0c0f7f… A seal
//     that does not identify whose record it covers is not evidence: one tenant's
//     seal would "verify" against another's export. tenantId is now hashed in.
//
//  2. Only YESTERDAY was ever sealed. Events spanned 2026-05-12 to 2026-08-06
//     (CloudTrail backfills up to 90 days) while exactly one day carried a seal,
//     so the overwhelming majority of the record had no tamper evidence at all
//     and never would have. Every settled unsealed day is now sealed, oldest
//     first so the chain links in order.
//
//  3. Worst of the three: a day was sealed while it could still receive rows.
//     The cron sealed "yesterday IST" while the same scan was still capturing
//     rows for that day — the seal recorded rowCount 20 for a day that ended up
//     with 40. Both tables reject UPDATE and the insert is ON CONFLICT DO
//     NOTHING, so that stale seal can never be corrected: a verifier recomputing
//     the digest finds a mismatch and concludes the record was tampered with.
//     A false tamper alarm is as damaging as a missed one — it discredits the
//     entire record. A day is now sealed only once every polled source has
//     captured past it (see isSettled below).
//
// Genuine remaining limitation: an event arriving for a day AFTER that day was
// legitimately settled and sealed still cannot update its seal. That is now a
// true edge case rather than the normal path, and the coverage/watermark system
// is what surfaces it.
import { createHash } from 'node:crypto';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { getPool } from '../../discovery/services/db.js';
import { createLogger } from '../../../lib/logger.js';
import { SCALING_AUDIT_CONFIG } from '../config.js';

dayjs.extend(utc);
dayjs.extend(timezone);

const log = createLogger('scaling-audit-seal');

function sha256(input: string): string {
    return createHash('sha256').update(input).digest('hex');
}

/**
 * The hash preimage. tenantId is included so a seal is bound to the record it
 * covers — see defect 1. Changing this function invalidates every previously
 * computed seal by design; seals are re-derivable only by re-sealing from scratch.
 */
export function computeSeal(tenantId: string, day: string, rowCount: number, rowsDigest: string, prevSeal: string | null): string {
    return sha256(`${prevSeal ?? ''}|${tenantId}|${day}|${rowCount}|${rowsDigest}`);
}

/** Seal exactly one day. Assumes the caller has established the day is settled. */
export async function sealDay(tenantId: string, day: string): Promise<void> {
    const client = await getPool().connect();
    try {
        const rows = await client.query(
            `SELECT "activityId", source, cause, "desiredBefore", "desiredAfter", "startedAt"
             FROM scaling_events
             WHERE "tenantId" = $1 AND "reportDateIst" = $2::date
             ORDER BY "activityId", source`,
            [tenantId, day]
        );
        const rowCount = rows.rowCount ?? 0;
        const rowsDigest = sha256(
            JSON.stringify(rows.rows.map((r) => [r.activityId, r.source, r.cause, r.desiredBefore, r.desiredAfter, r.startedAt]))
        );

        const prevRes = await client.query(
            `SELECT seal FROM scaling_audit_daily_seals WHERE "tenantId" = $1 AND day < $2::date ORDER BY day DESC LIMIT 1`,
            [tenantId, day]
        );
        const prevSeal: string | null = prevRes.rows[0]?.seal ?? null;
        const seal = computeSeal(tenantId, day, rowCount, rowsDigest, prevSeal);

        await client.query(
            `INSERT INTO scaling_audit_daily_seals (id, "tenantId", day, "rowCount", "rowsDigest", "prevSeal", seal, "sealedAt")
             VALUES (gen_random_uuid()::text, $1, $2::date, $3, $4, $5, $6, now())
             ON CONFLICT ("tenantId", day) DO NOTHING`,
            [tenantId, day, rowCount, rowsDigest, prevSeal, seal]
        );
    } finally {
        client.release();
    }
}

interface SealOutcome {
    sealed: string[];
    /** Set when nothing could be sealed, with the reason — never a silent no-op. */
    blockedReason?: string;
    settledThrough?: string;
}

/**
 * Seal every settled, unsealed day for a tenant, oldest first.
 *
 * "Settled" means no polled source can still insert rows for that day:
 *   - the day is strictly before today in the report timezone, AND
 *   - the day is strictly before the EARLIEST lastPolledAt across the tenant's
 *     watermarks (the slowest source bounds what is safe to seal), AND
 *   - no watermark reports a gap — a known gap means the period is incomplete,
 *     and sealing it would attest to a completeness we do not have.
 */
export async function sealPendingDays(tenantId: string, now: Date = new Date()): Promise<SealOutcome> {
    const client = await getPool().connect();
    try {
        const wm = await client.query(
            `SELECT min("lastPolledAt") AS slowest, bool_or("gapDetected") AS any_gap, count(*)::int AS n
               FROM scaling_audit_watermarks WHERE "tenantId" = $1`,
            [tenantId]
        );
        const { slowest, any_gap: anyGap, n } = wm.rows[0] ?? {};

        // Never scanned: nothing has been captured, so there is nothing to attest.
        if (!n || !slowest) return { sealed: [], blockedReason: 'no_watermarks_yet' };

        // A known gap means this tenant's record is incomplete for some window.
        // Sealing anyway would put a cryptographic signature on a record we
        // already know is missing data.
        if (anyGap) return { sealed: [], blockedReason: 'gap_detected' };

        const tz = SCALING_AUDIT_CONFIG.reportTimezone;
        const todayIst = dayjs(now).tz(tz).format('YYYY-MM-DD');
        const polledThroughIst = dayjs(slowest as Date).tz(tz).format('YYYY-MM-DD');
        // Strictly before BOTH: the slowest source has fully covered every day
        // before the day it last polled in.
        const settledThrough = (polledThroughIst < todayIst ? polledThroughIst : todayIst);

        const candidates = await client.query(
            `SELECT DISTINCT to_char(e."reportDateIst", 'YYYY-MM-DD') AS day
               FROM scaling_events e
              WHERE e."tenantId" = $1
                AND e."reportDateIst" < $2::date
                AND NOT EXISTS (
                      SELECT 1 FROM scaling_audit_daily_seals s
                       WHERE s."tenantId" = e."tenantId" AND s.day = e."reportDateIst")
              ORDER BY day ASC`,
            [tenantId, settledThrough]
        );

        const sealed: string[] = [];
        // Ascending, so each day's prevSeal is the day before it — the chain only
        // links correctly if sealed in order.
        for (const row of candidates.rows) {
            await sealDay(tenantId, row.day as string);
            sealed.push(row.day as string);
        }

        if (sealed.length > 0) log.info('Sealed days', { tenantId, count: sealed.length, from: sealed[0], to: sealed[sealed.length - 1], settledThrough });
        return { sealed, settledThrough };
    } finally {
        client.release();
    }
}
