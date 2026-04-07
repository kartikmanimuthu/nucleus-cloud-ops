// workers/src/jobs/discovery/services/account-service.ts
import type { PoolClient } from 'pg';
import type { Account } from '../types.js';
import { getPool } from './db.js';
import { createLogger } from '../../../lib/logger.js';

const log = createLogger('discovery/account');

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
    log.error('Error fetching active tenants', { error: error instanceof Error ? error.message : String(error) });
    throw error;  // re-throw so pg-boss retries the fan-out job
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
    log.error('Error fetching tenant accounts', { tenantId, error: error instanceof Error ? error.message : String(error) });
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
    log.error('Error updating account sync status', { tenantId, accountId, error: error instanceof Error ? error.message : String(error) });
    // Non-fatal — don't throw
  } finally {
    client.release();
  }
}
