import type PgBoss from 'pg-boss';
import { createLogger } from '../../lib/logger.js';
import type { JobExecutor } from '../../executor/index.js';
import { handleFileUpload } from './handlers/file-upload.js';
import { handleS3Sync } from './handlers/s3-sync.js';
import { handleConfluenceSync } from './handlers/confluence-sync.js';
import { handleBitbucketSync } from './handlers/bitbucket-sync.js';
import { getDataSource, updateDS, updateKBVectorCount } from './lib/vector-store.js';
import { deleteOldVectors } from './lib/embedding.js';
import type { KBSyncJob } from './types.js';

const log = createLogger('kb-sync');

const JOB_NAME = 'kb-sync';

export async function handleKbSyncJob(jobData: unknown): Promise<void> {
  const job = jobData as KBSyncJob;
  const { kbId, dsId } = job;

  log.info(`Processing ${job.type}`, { kbId, dsId });

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
          log.error(`Error ${job.data.type}`, { kbId: job.data.kbId, dsId: job.data.dsId, error: String(err) });
          try {
            await updateDS(job.data.kbId, job.data.dsId, {
              status: 'error',
              lastSyncError: err instanceof Error ? err.message : 'Sync failed',
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
