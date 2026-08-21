import PgBoss from 'pg-boss';
import { env } from '@/env';

let _bossPromise: Promise<PgBoss> | null = null;

/**
 * Singleton pg-boss client for the web-ui (producer-only mode).
 *
 * The instance is cached as a PROMISE, not a resolved value, so concurrent
 * callers during cold start all await the same in-flight start() instead of a
 * second caller receiving an unstarted instance and throwing on send(). If
 * start() rejects, the cached promise is cleared so the next request retries a
 * fresh connection rather than being wedged on a permanently-broken client until
 * redeploy.
 *
 * The 'error' listener is mandatory: pg-boss is an EventEmitter, and an 'error'
 * emission with no listener crashes the Node process (the whole web-ui task).
 */
export function getBoss(): Promise<PgBoss> {
  if (_bossPromise) return _bossPromise;

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    return Promise.reject(new Error('DATABASE_URL is required for pg-boss'));
  }

  _bossPromise = (async () => {
    const boss = new PgBoss({
      connectionString: databaseUrl,
      noScheduling: true,
      noSupervisor: true,
      // migrate is left at its default (true): both apps are pinned to the SAME
      // pg-boss version, so the schema migration is idempotent and advisory-lock
      // guarded no matter which process starts first. This avoids a cold-start
      // dependency where a web-ui that deploys before the workers cannot enqueue.
    });
    boss.on('error', (err) => {
      console.error('[pg-boss producer] error event:', err);
    });
    await boss.start();
    await ensureProducerQueues(boss);
    return boss;
  })();

  // If startup fails, drop the cached rejected promise so callers can retry.
  _bossPromise.catch(() => {
    _bossPromise = null;
  });

  return _bossPromise;
}

/**
 * Idempotently create the queues the web-ui enqueues into, so a send() never
 * fails with "Queue does not exist" in a fresh environment (or if the workers
 * service rolls back before the web-ui). Policies here MUST match the workers'
 * definitions: the scan queues are 'stately' so the workers' own stately setup
 * finds them already correct and skips its purge-migration. Everything the
 * workers additionally enforce (expiry, dead-letter) is applied by the workers.
 */
async function ensureProducerQueues(boss: PgBoss): Promise<void> {
  // Spot Guard: 'spot-guard-restore-scan' is stately (per-tenant, bounded), while
  // 'spot-guard-bus-policy-reconcile' is a standard queue the account-lifecycle hooks
  // enqueue onto. Pre-creating both here means a web-ui-first rollout can still enqueue
  // before the workers deploy lands, instead of failing with "queue does not exist".
  const stately: string[] = [
    'scheduler-scan',
    'discovery-scan',
    'right-sizing-scan',
    'spot-guard-restore-scan',
    'spot-guard-report-scan',
  ];
  const standard: string[] = ['kb-sync', 'scheduler-reschedule', 'spot-guard-bus-policy-reconcile'];
  await Promise.all([
    ...stately.map((name) =>
      boss.createQueue(name, { name, policy: 'stately' }).catch((e) =>
        console.error(`[pg-boss producer] ensureQueue ${name} failed`, e),
      ),
    ),
    ...standard.map((name) =>
      boss.createQueue(name).catch((e) =>
        console.error(`[pg-boss producer] ensureQueue ${name} failed`, e),
      ),
    ),
  ]);
}
