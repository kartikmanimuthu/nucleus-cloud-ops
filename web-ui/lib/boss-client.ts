import PgBoss from 'pg-boss';

let _boss: PgBoss | null = null;

/**
 * Singleton pg-boss client for the web-ui (producer-only mode).
 * Connects lazily on first use. No workers registered here —
 * the workers container handles all job processing.
 */
export async function getBoss(): Promise<PgBoss> {
  if (_boss) return _boss;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for pg-boss');
  }

  _boss = new PgBoss({
    connectionString: databaseUrl,
    noScheduling: true,
    noSupervisor: true,
  });

  await _boss.start();
  return _boss;
}
