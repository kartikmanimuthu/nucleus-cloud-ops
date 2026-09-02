import type { PoolClient } from 'pg';
import type { ResourceEdge } from '../types.js';
import { getPool } from './db.js';
import { createLogger } from '../../../lib/logger.js';

const log = createLogger('discovery/edge-writer');

const BATCH_SIZE = 500;

export async function writeEdgesToPg(
  edges: ResourceEdge[],
  tenantId: string,
  accountId: string,
  fallbackRegion: string,
  jobRunId: string,
): Promise<number> {
  if (!edges.length) return 0;

  const client: PoolClient = await getPool().connect();
  let total = 0;

  try {
    for (let i = 0; i < edges.length; i += BATCH_SIZE) {
      const batch = edges.slice(i, i + BATCH_SIZE);
      const placeholders: string[] = [];
      const params: any[] = [];
      let p = 1;

      for (const e of batch) {
        const id = `edge-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
        placeholders.push(
          `($${p}, $${p + 1}, $${p + 2}, $${p + 3}, $${p + 4}, $${p + 5}, $${p + 6}, $${p + 7}, $${p + 8}, $${p + 9}, $${p + 10}, true, NOW(), NOW())`,
        );
        params.push(
          id,
          tenantId,
          accountId,
          e.region ?? fallbackRegion,
          e.fromType,
          e.fromId,
          e.relation,
          e.toType,
          e.toId,
          e.toAccountId ?? null,
          jobRunId,
        );
        p += 11;
      }

      const sql = `
        INSERT INTO resource_edges
          (id, "tenantId", "accountId", region, "fromType", "fromId",
           relation, "toType", "toId", "toAccountId", "jobRunId",
           "isCurrent", "discoveredAt", "updatedAt")
        VALUES ${placeholders.join(', ')}
        ON CONFLICT ("tenantId", "accountId", "fromType", "fromId", relation, "toType", "toId")
        DO UPDATE SET
          region = EXCLUDED.region,
          "toAccountId" = EXCLUDED."toAccountId",
          "jobRunId" = EXCLUDED."jobRunId",
          "discoveredAt" = EXCLUDED."discoveredAt",
          "updatedAt" = NOW(),
          "isCurrent" = true
      `;

      await client.query(sql, params);
      total += batch.length;
    }
  } catch (error) {
    log.error('Failed writing edges', { error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    client.release();
  }

  log.debug('Wrote edges', { tenantId, accountId, count: total });
  return total;
}

export async function reconcileStaleEdges(
  tenantId: string,
  accountId: string,
  jobRunId: string,
): Promise<number> {
  const client: PoolClient = await getPool().connect();
  try {
    const result = await client.query(
      `UPDATE resource_edges
       SET "isCurrent" = false, "updatedAt" = NOW()
       WHERE "tenantId" = $1
         AND "accountId" = $2
         AND "isCurrent" = true
         AND ("jobRunId" IS DISTINCT FROM $3)`,
      [tenantId, accountId, jobRunId],
    );
    return result.rowCount ?? 0;
  } finally {
    client.release();
  }
}
