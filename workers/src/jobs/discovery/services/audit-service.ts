// workers/src/jobs/discovery/services/audit-service.ts
import type { PoolClient } from 'pg';
import { getPool } from './db.js';

export async function writeAuditLog(entry: {
  tenantId: string;
  eventType: string;
  action: string;
  resourceId: string;
  status: string;
  severity: string;
  details: string;
  metadata?: Record<string, unknown>;
  accountId?: string;
  region?: string;
}): Promise<void> {
  const client: PoolClient = await getPool().connect();
  try {
    const id = `log-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const logId = `log-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await client.query(
      `INSERT INTO audit_logs
         (id, "tenantId", "logId", timestamp, "eventType", action,
          "user", "userType", "resourceType", "resourceId",
          status, severity, details, metadata, "accountId", region, "expiresAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT DO NOTHING`,
      [
        id, entry.tenantId, logId, new Date(),
        entry.eventType, entry.action,
        'system', 'system',
        'discovery', entry.resourceId,
        entry.status, entry.severity, entry.details,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
        entry.accountId ?? null, entry.region ?? null, expiresAt,
      ],
    );
  } catch (error) {
    console.error('[discovery/audit] Error writing audit log:', error);
    // Non-fatal — don't throw
  } finally {
    client.release();
  }
}
