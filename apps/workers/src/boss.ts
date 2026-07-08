import PgBoss from 'pg-boss';
import { env } from './env.js';

/**
 * How often each worker polls Postgres for new jobs.
 *
 * pg-boss (v10) has NO cross-process push (no LISTEN/NOTIFY): a job enqueued by
 * the web-ui process is only discovered by this workers process on its next
 * poll. The library default is 2000ms, which makes manually-triggered jobs
 * ("Execute Now") feel laggy — worst case a full 2s before pickup. We lower it
 * to 1s (configurable, floor 0.5s = pg-boss minimum) so interactive triggers are
 * picked up near-instantly. Cost is one small indexed SELECT per queue per
 * interval — negligible on Postgres.
 */
export const DEFAULT_POLL_INTERVAL_SECONDS = 1;
const MIN_POLL_INTERVAL_SECONDS = 0.5; // pg-boss POLICY.MIN_POLLING_INTERVAL_MS

export function resolvePollIntervalSeconds(raw: string | undefined): number {
  const parsed = raw != null ? Number(raw) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_POLL_INTERVAL_SECONDS;
  }
  return Math.max(parsed, MIN_POLL_INTERVAL_SECONDS);
}

/**
 * Build the pg-boss constructor options. Extracted as a pure function so the
 * polling-interval wiring can be unit-tested without a live database.
 */
export function buildBossOptions(databaseUrl: string): PgBoss.ConstructorOptions {
  return {
    connectionString: databaseUrl,
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
    expireInHours: 4,
    archiveCompletedAfterSeconds: 86400,
    deleteAfterDays: 7,
    monitorStateIntervalSeconds: 30,
    // Applies as the default poll interval for every boss.work() consumer.
    pollingIntervalSeconds: resolvePollIntervalSeconds(env.PGBOSS_POLL_INTERVAL_SECONDS),
  };
}

export function createBoss(): PgBoss {
  const DATABASE_URL = env.DATABASE_URL;
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  return new PgBoss(buildBossOptions(DATABASE_URL));
}
