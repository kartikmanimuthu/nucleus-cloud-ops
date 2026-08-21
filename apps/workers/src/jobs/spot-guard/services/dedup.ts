// workers/src/jobs/spot-guard/services/dedup.ts
//
// Slack alert dedup for Spot Guard (SG-003) — the Postgres replacement for DynamoDB
// PutItem + ConditionExpression("attribute_not_exists(PK)") + TTL.
//
// Raw pg on purpose: the getTenantClient() Prisma extension does not intercept raw SQL
// (documented in apps/web-ui/lib/db/pg-config.ts), and this needs one exact statement
// rather than an ORM round-trip. Every query here scopes tenantId explicitly.
//
// SCOPE: this gates SLACK DELIVERY ONLY. It must never gate the spot_guard_events row.
// The reference implementation throttled the alert itself, which was fine when there
// was no UI — but here the event row IS the product surface, and suppressing rows
// during a burst of interruptions would punch holes in the timeline at exactly the
// moment an operator is looking at it.
import { getPool } from '../../discovery/services/db.js';
import { createLogger } from '../../../lib/logger.js';
import { DEDUP_WINDOWS_SECONDS, type AlertType } from '../config.js';

const log = createLogger('spot-guard-dedup');

export interface AlertClaim {
    /** True when the caller won the window and should actually send the alert. */
    granted: boolean;
    /** When the current window closes. */
    windowEndsAt: Date | null;
    /** How many alerts this window has swallowed — surfaced in the UI. */
    suppressedCount: number;
}

/**
 * Build the dedup key.
 *
 * BUG FIX: the reference keyed on `{TYPE}#{account}#{service}` only, so two clusters
 * each running a service named `api` in one AWS account shared a single throttle
 * window and silently suppressed each other's alerts. Region was missing too, so the
 * same service name in two regions collided. Cluster and region are now part of the key.
 */
export function buildDedupKey(input: {
    alertType: AlertType;
    accountId: string;
    region: string;
    clusterName: string;
    serviceName: string;
}): string {
    return [input.alertType, input.accountId, input.region, input.clusterName, input.serviceName].join('#');
}

/**
 * The conditional-reclaim upsert. One statement, race-free, and it re-permits the
 * alert once the window expires.
 *
 * Why not a plain unique index + INSERT ... ON CONFLICT DO NOTHING: that gives
 * atomicity but blocks re-inserts FOREVER after expiry, so the alert would be
 * suppressed permanently rather than for windowSeconds. Correctness has to live in the
 * predicate, not in a reaper.
 *
 * Three non-obvious details, each load-bearing:
 *
 *  1. `DO UPDATE`, not `DO NOTHING`. DO NOTHING returns zero rows on conflict, so the
 *     caller cannot distinguish "suppressed" from "expired, should re-permit".
 *
 *  2. `granted` is derived from the SUPPRESSION COUNTER, not from comparing timestamps.
 *
 *     This is the subtle one, and it was caught by an integration test against a real
 *     Postgres. The obvious-looking derivation is `firstSeenAt = lastSeenAt` — true on
 *     a fresh insert and on a window reclaim, false on a suppression because lastSeenAt
 *     advances while firstSeenAt is held. It is WRONG here: both columns are
 *     TIMESTAMP(3), i.e. millisecond precision, so two claims arriving within the same
 *     millisecond (routine for consecutive queries, and near-certain for concurrent
 *     replicas) store the SAME value and every claim reports granted. Dedup silently
 *     did nothing.
 *
 *     The counter has no such precision floor: a reclaim resets suppressedCount to 0
 *     and a suppression always increments it to ≥ 1, so `suppressedCount = 0` means
 *     "granted" for both grant cases and nothing else. Fresh insert starts at 0.
 *
 *  3. `statement_timestamp()`, NOT `now()`. `now()` is transaction_timestamp() and is
 *     frozen for the whole transaction, so inside a long-running transaction the expiry
 *     comparison would be evaluated against the transaction's start time rather than
 *     the current instant — widening every window by however long the transaction has
 *     been open. statement_timestamp() advances per statement.
 *
 * INSERT ... ON CONFLICT DO UPDATE takes a row lock on the conflicting tuple, so
 * concurrent callers serialise: the loser re-reads the winner's committed row, sees the
 * fresh expiresAt, and the reclaim predicate is false.
 */
const CLAIM_SQL = `
INSERT INTO spot_guard_alert_dedup
    (id, "tenantId", "dedupKey", "alertType", "windowSeconds",
     "firstSeenAt", "lastSeenAt", "hitCount", "suppressedCount", "expiresAt")
-- NOTE: the window is bound TWICE, as $4 (the integer column) and $5 (the interval
-- seconds), with the same value passed for both. Reusing a single $4 for both looks
-- tidier but fails at prepare time with "inconsistent types deduced for parameter $4",
-- because Postgres cannot infer one type that satisfies both an INTEGER column
-- assignment and make_interval's double-precision secs argument.
VALUES (gen_random_uuid()::text, $1, $2, $3, $4,
        statement_timestamp(), statement_timestamp(), 1, 0,
        statement_timestamp() + make_interval(secs => $5::double precision))
ON CONFLICT ("tenantId", "dedupKey") DO UPDATE
   SET "lastSeenAt"    = statement_timestamp(),
       "hitCount"      = spot_guard_alert_dedup."hitCount" + 1,
       "windowSeconds" = EXCLUDED."windowSeconds",
       "firstSeenAt"   = CASE WHEN spot_guard_alert_dedup."expiresAt" <= statement_timestamp()
                              THEN statement_timestamp()
                              ELSE spot_guard_alert_dedup."firstSeenAt" END,
       "expiresAt"     = CASE WHEN spot_guard_alert_dedup."expiresAt" <= statement_timestamp()
                              THEN statement_timestamp() + make_interval(secs => EXCLUDED."windowSeconds"::double precision)
                              ELSE spot_guard_alert_dedup."expiresAt" END,
       "suppressedCount" = CASE WHEN spot_guard_alert_dedup."expiresAt" <= statement_timestamp()
                                THEN 0
                                ELSE spot_guard_alert_dedup."suppressedCount" + 1 END
-- granted comes from the counter, never from a timestamp comparison — see (2) above.
RETURNING ("suppressedCount" = 0) AS granted,
          "expiresAt"             AS "windowEndsAt",
          "suppressedCount"       AS "suppressedCount"
`;

/**
 * Try to claim the alert window for `dedupKey`.
 *
 * A window of 0 seconds means "never dedup" (user-initiated actions must always
 * notify) and short-circuits without touching the table.
 *
 * FAILS OPEN. On a query error this returns granted:true, so a database hiccup
 * produces a duplicate Slack message rather than silence. The reference did the
 * opposite — `except Exception: return True` treated every error as "already alerted",
 * so a DynamoDB blip silently muted ALL alerting with no trace. Same fail-open
 * reasoning as apps/web-ui/lib/agent/thread-lock.ts.
 */
export async function claimAlertWindow(input: {
    tenantId: string;
    dedupKey: string;
    alertType: AlertType;
    /** Defaults to the ported window for this alert type. */
    windowSeconds?: number;
}): Promise<AlertClaim> {
    const windowSeconds = input.windowSeconds ?? DEDUP_WINDOWS_SECONDS[input.alertType];

    if (windowSeconds <= 0) {
        return { granted: true, windowEndsAt: null, suppressedCount: 0 };
    }

    const client = await getPool().connect();
    try {
        const { rows } = await client.query<{
            granted: boolean;
            windowEndsAt: Date;
            suppressedCount: number;
        }>(CLAIM_SQL, [input.tenantId, input.dedupKey, input.alertType, windowSeconds, windowSeconds]);

        const row = rows[0];
        if (!row) {
            // Should be unreachable — the statement always RETURNs exactly one row.
            log.warn('Dedup claim returned no row — failing open', { dedupKey: input.dedupKey });
            return { granted: true, windowEndsAt: null, suppressedCount: 0 };
        }
        return {
            granted: row.granted,
            windowEndsAt: row.windowEndsAt,
            suppressedCount: Number(row.suppressedCount ?? 0),
        };
    } catch (err) {
        log.error('Dedup claim failed — failing OPEN so the alert is not silently lost', {
            dedupKey: input.dedupKey,
            alertType: input.alertType,
            error: err instanceof Error ? err.message : String(err),
        });
        return { granted: true, windowEndsAt: null, suppressedCount: 0 };
    } finally {
        client.release();
    }
}
