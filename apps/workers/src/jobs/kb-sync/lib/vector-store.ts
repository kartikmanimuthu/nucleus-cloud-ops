import { Pool, type PoolClient } from 'pg';
import { env } from '../../../env.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const DEFAULT_TENANT = env.DEFAULT_TENANT_ID || 'org-default';

// ---------------------------------------------------------------------------
// pg Pool lazy init (matches scheduler/discovery pattern — no Prisma)
// ---------------------------------------------------------------------------

let _pool: Pool | null = null;
export function getPool(): Pool {
  if (!_pool) {
    const DATABASE_URL = env.DATABASE_URL;
    if (!DATABASE_URL) throw new Error('DATABASE_URL is required for kb-sync PG mode');
    _pool = new Pool({
      connectionString: DATABASE_URL,
      max: 3,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000,
    });
  }
  return _pool;
}

// ---------------------------------------------------------------------------
// PostgreSQL helpers (raw pg — no Prisma dependency)
// ---------------------------------------------------------------------------

export async function getDataSource(kbId: string, dsId: string) {
  const client: PoolClient = await getPool().connect();
  try {
    const result = await client.query(
      `SELECT "vectorCount", "vectorKeys", status
       FROM data_sources
       WHERE id = $1 AND "knowledgeBaseId" = $2
       LIMIT 1`,
      [dsId, kbId]
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      vectorCount: row.vectorCount as number,
      vectorKeys: row.vectorKeys as string[],
      status: row.status as string,
    };
  } finally {
    client.release();
  }
}

export async function updateDS(kbId: string, dsId: string, updates: Record<string, unknown>) {
  const setClauses: string[] = ['"updatedAt" = NOW()'];
  const values: unknown[] = [];
  let paramIdx = 1;

  const fieldMap: Record<string, string> = {
    status: 'status',
    vectorCount: '"vectorCount"',
    lastSyncAt: '"lastSyncAt"',
    lastSyncError: '"lastSyncError"',
    lastErrorMessage: '"lastErrorMessage"',
    lastErrorDetail: '"lastErrorDetail"',
  };

  for (const [key, col] of Object.entries(fieldMap)) {
    if (updates[key] !== undefined) {
      setClauses.push(`${col} = $${paramIdx}`);
      if (key === 'lastSyncAt' && updates[key]) {
        values.push(new Date(updates[key] as string));
      } else {
        values.push(updates[key]);
      }
      paramIdx++;
    }
  }

  // vectorKeys needs special handling (text array)
  if (updates.vectorKeys !== undefined) {
    setClauses.push(`"vectorKeys" = $${paramIdx}`);
    values.push(updates.vectorKeys as string[]);
    paramIdx++;
  }

  values.push(dsId, kbId);

  const client: PoolClient = await getPool().connect();
  try {
    await client.query(
      `UPDATE data_sources SET ${setClauses.join(', ')}
       WHERE id = $${paramIdx} AND "knowledgeBaseId" = $${paramIdx + 1}`,
      values
    );
  } finally {
    client.release();
  }
}

export async function updateKBVectorCount(kbId: string, delta: number) {
  if (delta === 0) return;
  const client: PoolClient = await getPool().connect();
  try {
    await client.query(
      `UPDATE knowledge_bases
       SET "vectorCount" = COALESCE("vectorCount", 0) + $1, "updatedAt" = NOW()
       WHERE id = $2`,
      [delta, kbId]
    );
  } finally {
    client.release();
  }
}
