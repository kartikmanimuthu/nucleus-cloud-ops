import type PgBoss from 'pg-boss';
import { createLogger } from '../../lib/logger.js';
import type { JobExecutor } from '../../executor/index.js';
import { handleFileUpload } from './handlers/file-upload.js';
import { handleS3Sync } from './handlers/s3-sync.js';
import { handleConfluenceSync } from './handlers/confluence-sync.js';
import { handleBitbucketSync } from './handlers/bitbucket-sync.js';
import { getDataSource, updateDS, updateKBVectorCount, getPool } from './lib/vector-store.js';
import { deleteOldVectors } from './lib/embedding.js';
import type { KBSyncJob } from './types.js';

const log = createLogger('kb-sync');

const JOB_NAME = 'kb-sync';

async function writeAuditLog(entry: {
  tenantId: string;
  eventType: string;
  action: string;
  resourceId: string;
  status: string;
  severity: string;
  details: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const client = await getPool().connect();
  try {
    const id = `log-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const logId = `log-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await client.query(
      `INSERT INTO audit_logs
         (id, "tenantId", "logId", timestamp, "eventType", action,
          "user", "userType", "resourceType", "resourceId",
          status, severity, details, metadata, "expiresAt", source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT DO NOTHING`,
      [
        id, entry.tenantId, logId, new Date(),
        entry.eventType, entry.action,
        'system', 'system',
        'kb', entry.resourceId,
        entry.status, entry.severity, entry.details,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
        expiresAt, 'system',
      ],
    );
  } catch (error) {
    log.error('Error writing audit log', { error: error instanceof Error ? error.message : String(error) });
  } finally {
    client.release();
  }
}

export async function handleKbSyncJob(jobData: unknown): Promise<void> {
  const job = jobData as KBSyncJob;
  const { kbId, dsId, tenantId } = job;
  const startedAt = Date.now();

  log.info(`Processing ${job.type}`, { kbId, dsId });

  await writeAuditLog({
    tenantId,
    eventType: 'kb.sync.started',
    action: 'KB Sync Started',
    resourceId: dsId,
    status: 'info',
    severity: 'info',
    details: `KB sync started for data source ${dsId} (type: ${job.type})`,
    metadata: { kbId, dsId, type: job.type },
  });

  const ds = await getDataSource(kbId, dsId);
  const oldVectorCount = (ds?.vectorCount as number) || 0;
  const oldVectorKeys: string[] = job.oldVectorKeys || (ds?.vectorKeys as string[]) || [];

  // Delete old vectors
  if (oldVectorKeys.length) {
    await deleteOldVectors(oldVectorKeys);
    await updateKBVectorCount(kbId, -oldVectorCount);
  }

  let vectorKeys: string[];
  switch (job.type) {
    case 'file-upload':      vectorKeys = await handleFileUpload(job); break;
    case 's3-sync':          vectorKeys = await handleS3Sync(job); break;
    case 'confluence-sync':  vectorKeys = await handleConfluenceSync(job); break;
    case 'bitbucket-sync':   vectorKeys = await handleBitbucketSync(job); break;
    default: throw new Error(`Unknown job type: ${(job as KBSyncJob).type}`);
  }

  await updateDS(kbId, dsId, {
    status: 'synced',
    vectorCount: vectorKeys.length,
    vectorKeys,
    lastSyncAt: new Date().toISOString(),
    lastSyncError: null,
  });
  await updateKBVectorCount(kbId, vectorKeys.length);

  const duration = Date.now() - startedAt;

  await writeAuditLog({
    tenantId,
    eventType: 'kb.sync.completed',
    action: 'KB Sync Completed',
    resourceId: dsId,
    status: 'success',
    severity: 'info',
    details: `KB sync completed for data source ${dsId}: ${vectorKeys.length} vectors`,
    metadata: { kbId, dsId, type: job.type, vectorCount: vectorKeys.length, duration },
  });

  log.info(`Done ${job.type}`, { kbId, dsId, vectors: vectorKeys.length });
}

export async function register(boss: PgBoss, executor: JobExecutor): Promise<void> {
  // Register handler with executor (used by VerticalExecutor for in-process dispatch)
  executor.registerHandler?.(JOB_NAME, handleKbSyncJob);

  // Create queue first (required in pg-boss v10 before work)
  await boss.createQueue(JOB_NAME);

  // batchSize: 3 — max 3 concurrent KB jobs to avoid Bedrock rate limiting
  await boss.work<KBSyncJob>(
    JOB_NAME,
    { batchSize: 3 },
    async (jobs) => {
      for (const job of jobs) {
        try {
          await executor.execute(JOB_NAME, job.data);
        } catch (err) {
          const shortMessage = err instanceof Error ? err.message.slice(0, 200) : String(err);
          const fullDetail = err instanceof Error ? (err.stack ?? err.message) : String(err);
          log.error(`Error ${job.data.type}`, { kbId: job.data.kbId, dsId: job.data.dsId, error: String(err) });

          await writeAuditLog({
            tenantId: job.data.tenantId,
            eventType: 'kb.sync.failed',
            action: 'KB Sync Failed',
            resourceId: job.data.dsId,
            status: 'error',
            severity: 'high',
            details: `KB sync failed for data source ${job.data.dsId}: ${shortMessage}`,
            metadata: { kbId: job.data.kbId, dsId: job.data.dsId, type: job.data.type, error: shortMessage },
          });

          try {
            await updateDS(job.data.kbId, job.data.dsId, {
              status: 'error',
              lastSyncError: shortMessage,
              lastErrorMessage: shortMessage,
              lastErrorDetail: fullDetail,
            });
          } catch (e) {
            log.error('Error update failed', { error: String(e) });
          }
          throw err; // Re-throw so pg-boss retries
        }
      }
    },
  );

  log.info('Registered kb-sync job');
}
