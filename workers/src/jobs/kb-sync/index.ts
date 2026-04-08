import type PgBoss from 'pg-boss';
import { handleFileUpload } from './handlers/file-upload.js';
import { handleS3Sync } from './handlers/s3-sync.js';
import { handleConfluenceSync } from './handlers/confluence-sync.js';
import { handleBitbucketSync } from './handlers/bitbucket-sync.js';
import { getDataSource, updateDS, updateKBVectorCount } from './lib/vector-store.js';
import { deleteOldVectors } from './lib/embedding.js';
import type { KBSyncJob } from './types.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('kb-sync');

export async function register(boss: PgBoss): Promise<void> {
  // Create queue first (required in pg-boss v10 before work)
  await boss.createQueue('kb-sync');

  // batchSize: 3 — max 3 concurrent KB jobs to avoid Bedrock rate limiting
  await boss.work<KBSyncJob>(
    'kb-sync',
    { batchSize: 3 },
    async (jobs) => {
      for (const job of jobs) {
        const { kbId, dsId } = job.data;

        log.info('Processing job', { jobId: job.id, type: job.data.type, kbId, dsId });

        const ds = await getDataSource(kbId, dsId);
        const oldVectorCount = (ds?.vectorCount as number) || 0;
        const oldVectorKeys: string[] = job.data.oldVectorKeys || (ds?.vectorKeys as string[]) || [];

        try {
          // Delete old vectors
          if (oldVectorKeys.length) {
            await deleteOldVectors(oldVectorKeys);
            await updateKBVectorCount(kbId, -oldVectorCount);
          }

          let vectorKeys: string[];
          switch (job.data.type) {
            case 'file-upload':    vectorKeys = await handleFileUpload(job.data); break;
            case 's3-sync':        vectorKeys = await handleS3Sync(job.data); break;
            case 'confluence-sync': vectorKeys = await handleConfluenceSync(job.data); break;
            case 'bitbucket-sync': vectorKeys = await handleBitbucketSync(job.data); break;
            default: throw new Error(`Unknown job type: ${(job.data as KBSyncJob).type}`);
          }

          await updateDS(kbId, dsId, {
            status: 'synced',
            vectorCount: vectorKeys.length,
            vectorKeys,
            lastSyncAt: new Date().toISOString(),
            lastSyncError: null,
          });
          await updateKBVectorCount(kbId, vectorKeys.length);

          log.info('Job complete', { jobId: job.id, type: job.data.type, kbId, dsId, vectorCount: vectorKeys.length });
        } catch (err) {
          const shortMessage = err instanceof Error ? err.message : 'Sync failed';
          const fullDetail = err instanceof Error
            ? `${err.message}\n${err.stack ?? ''}`
            : String(err);
          log.error('Job failed', { jobId: job.id, type: job.data.type, kbId, dsId, error: shortMessage });
          try {
            await updateDS(kbId, dsId, {
              status: 'error',
              lastSyncError: shortMessage,
              lastErrorMessage: shortMessage,
              lastErrorDetail: fullDetail,
            });
          } catch (e) {
            log.error('Status update failed', { jobId: job.id, kbId, dsId, error: e instanceof Error ? e.message : String(e) });
          }
          throw err; // Re-throw so pg-boss retries
        }
      }
    },
  );

  log.info('Registered queues', { queues: ['kb-sync'], batchSize: 3 });
}
