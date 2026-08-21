// workers/src/jobs/spot-guard/report/query.ts
//
// The Spot-vs-On-Demand hours query (SG-009).
//
// TIME-WEIGHTED INTERVAL CLIPPING, not grouping by a stored date. This is what
// structurally fixes two bugs in the reference implementation:
//
//   * Midnight-spanning tasks. The reference keyed session rows by the task's createdAt
//     date, so a task running 22:00 -> 02:00 was filed entirely on the wrong day. The
//     naive fix (switch to stoppedAt) just moves the whole duration to the OTHER wrong
//     day. Clipping puts 2h on each day, which is what actually happened. There is no
//     day key here at all — reportDate on the row is only a coarse indexed pre-filter and
//     a human-readable label, never the source of truth.
//
//   * Silent truncation. The reference issued an unpaginated DynamoDB query and lost
//     everything past 1 MB. Aggregating server-side with GROUP BY returns one row per
//     (account, cluster, service, capacityType) — a few hundred rows at most — so
//     truncation is structurally impossible rather than merely "paginated correctly".
//
// IN-FLIGHT TASKS ARE COUNTED, clipped to the window end. This is a deliberate change:
// the reference summed only completed sessions, so a long-lived service that never
// restarted reported ZERO hours and the report never matched live state. Clipping is
// monotone within a window and cannot double-count, because closing a session only pins
// win_end to the real stoppedAt.
import { getPool } from '../../discovery/services/db.js';
import type { CapacityType } from '../types.js';

export interface HoursRow {
    accountId: string;
    region: string;
    clusterName: string;
    serviceName: string;
    capacityType: CapacityType;
    seconds: number;
    sessions: number;
    inFlightSessions: number;
    interruptions: number;
}

export interface DataQualityRow {
    orphaned: number;
    staleOpen: number;
}

/**
 * NOTE ON PARAMETER TYPES — two traps avoided here, both of which have already cost time
 * in this feature:
 *
 *  1. Each of $2/$3/$4 is cast EXACTLY ONCE. Reusing one placeholder in two different
 *     type contexts fails at prepare time with "inconsistent types deduced for parameter
 *     $n" — which, behind a fail-open catch, looks exactly like working code.
 *
 *  2. ::timestamptz, NOT ::timestamptztz, and the clock is passed IN as $4 rather than using
 *     now(). startedAt/stoppedAt are TIMESTAMP(3) WITHOUT time zone, so mixing in a
 *     timestamptz would trigger an implicit session-timezone conversion and silently skew
 *     every duration on a server whose TimeZone is not UTC. Passing the clock as a
 *     parameter means the bounds and the stored values travel the same serialization
 *     path, and it makes the query deterministic for tests.
 */
const HOURS_SQL = `
WITH bounds AS (
    SELECT $2::timestamptz AS win_start,
           LEAST($3::timestamptz, $4::timestamptz) AS win_end
)
SELECT s."accountId",
       s.region,
       s."clusterName",
       s."serviceName",
       s."capacityType",
       SUM(EXTRACT(EPOCH FROM (
             LEAST(COALESCE(s."stoppedAt", b.win_end), b.win_end)
           - GREATEST(s."startedAt", b.win_start)
       )))                                             AS seconds,
       COUNT(*)                                        AS sessions,
       COUNT(*) FILTER (WHERE s."stoppedAt" IS NULL)   AS "inFlightSessions",
       COUNT(*) FILTER (WHERE s.interrupted)           AS interruptions
  FROM spot_guard_task_sessions s
 CROSS JOIN bounds b
 WHERE s."tenantId" = $1
   -- Orphans (STOPPED with no RUNNING ever seen) are excluded from hours and reported
   -- separately, so data loss stays VISIBLE instead of being counted as 0 seconds.
   AND s.orphaned = false
   AND s."startedAt" < b.win_end
   AND (s."stoppedAt" IS NULL OR s."stoppedAt" > b.win_start)
   -- Drop zero- and negative-length overlaps so they cannot contribute a 0 row.
   AND LEAST(COALESCE(s."stoppedAt", b.win_end), b.win_end) > GREATEST(s."startedAt", b.win_start)
 GROUP BY 1, 2, 3, 4, 5
 ORDER BY 1, 2, 3, 4, 5
`;

export async function queryHours(input: {
    tenantId: string;
    from: Date;
    to: Date;
    /** Injected clock, so the window can never extend past "now". */
    now?: Date;
}): Promise<HoursRow[]> {
    const client = await getPool().connect();
    try {
        const { rows } = await client.query(HOURS_SQL, [
            input.tenantId,
            input.from,
            input.to,
            input.now ?? new Date(),
        ]);
        // pg returns SUM/COUNT as strings (numeric/bigint); normalise at the boundary so
        // nothing downstream has to remember to.
        return rows.map((r) => ({
            accountId: r.accountId as string,
            region: r.region as string,
            clusterName: r.clusterName as string,
            serviceName: r.serviceName as string,
            capacityType: r.capacityType as CapacityType,
            seconds: Number(r.seconds ?? 0),
            sessions: Number(r.sessions ?? 0),
            inFlightSessions: Number(r.inFlightSessions ?? 0),
            interruptions: Number(r.interruptions ?? 0),
        }));
    } finally {
        client.release();
    }
}

/**
 * Counts that belong in a data-quality footer rather than in the hours themselves.
 *
 * staleOpen surfaces sessions still open well past any plausible task lifetime — the
 * signature of dropped STOPPED events. Without it, a systematic event loss would quietly
 * inflate in-flight hours and look like healthy long-running tasks.
 */
const QUALITY_SQL = `
SELECT COUNT(*) FILTER (WHERE orphaned)                                             AS orphaned,
       COUNT(*) FILTER (WHERE "isOpen" AND "startedAt" < $3::timestamptz - interval '7 days') AS "staleOpen"
  FROM spot_guard_task_sessions
 WHERE "tenantId" = $1
   AND "startedAt" >= $2::timestamptz
`;

export async function queryDataQuality(input: {
    tenantId: string;
    from: Date;
    now?: Date;
}): Promise<DataQualityRow> {
    const client = await getPool().connect();
    try {
        const { rows } = await client.query(QUALITY_SQL, [input.tenantId, input.from, input.now ?? new Date()]);
        return {
            orphaned: Number(rows[0]?.orphaned ?? 0),
            staleOpen: Number(rows[0]?.staleOpen ?? 0),
        };
    } finally {
        client.release();
    }
}
