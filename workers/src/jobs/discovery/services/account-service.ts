// workers/src/jobs/discovery/services/account-service.ts
import { Pool, type PoolClient } from 'pg';
import type { Account } from '../types.js';

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    const DATABASE_URL = process.env.DATABASE_URL;
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL environment variable is required');
    }
    pool = new Pool({
      connectionString: DATABASE_URL,
      max: 3,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000,
    });
  }
  return pool;
}

/**
 * Get all active tenants. Used by fan-out handler.
 */
export async function getAllTenants(): Promise<Array<{ id: string; name: string }>> {
  const client: PoolClient = await getPool().connect();
  try {
    const result = await client.query(
      `SELECT id, name FROM tenants WHERE status = 'active' ORDER BY "createdAt" ASC`,
    );
    return result.rows;
  } catch (error) {
    console.error('[discovery/account] Error fetching active tenants:', error);
    return [];
  } finally {
    client.release();
  }
}

/**
 * Get all active accounts for a tenant.
 */
export async function getTenantAccounts(tenantId: string): Promise<Account[]> {
  const client: PoolClient = await getPool().connect();
  try {
    const result = await client.query(
      `SELECT id, "tenantId", "accountId", name, "roleArn", "externalId",
              regions, active
       FROM accounts
       WHERE "tenantId" = $1
         AND active = true`,
      [tenantId],
    );
    return result.rows;
  } catch (error) {
    console.error('[discovery/account] Error fetching tenant accounts:', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Update account sync status after a discovery scan.
 */
export async function updateAccountSyncStatus(
  tenantId: string,
  accountId: string,
  status: {
    lastSyncedAt: string;
    lastSyncStatus: string;
    lastSyncResourceCount: number;
  },
): Promise<void> {
  const client: PoolClient = await getPool().connect();
  try {
    await client.query(
      `UPDATE accounts
       SET "connectionStatus" = $3,
           "updatedAt" = $4,
           "lastSyncedAt" = $5,
           "lastSyncResourceCount" = $6
       WHERE "tenantId" = $1
         AND "accountId" = $2`,
      [tenantId, accountId, status.lastSyncStatus, new Date(), new Date(status.lastSyncedAt), status.lastSyncResourceCount],
    );
  } catch (error) {
    console.error('[discovery/account] Error updating account sync status:', error);
    // Non-fatal — don't throw
  } finally {
    client.release();
  }
}
