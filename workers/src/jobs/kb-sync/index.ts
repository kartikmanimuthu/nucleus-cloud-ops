import type PgBoss from 'pg-boss';
import { handleFileUpload } from './handlers/file-upload.js';
import { handleS3Sync } from './handlers/s3-sync.js';
import { handleConfluenceSync } from './handlers/confluence-sync.js';
import { handleBitbucketSync } from './handlers/bitbucket-sync.js';
import { getDataSource, updateDS, updateKBVectorCount } from './lib/vector-store.js';
import { deleteOldVectors } from './lib/embedding.js';
import type { KBSyncJob } from './types.js';

export async function register(boss: PgBoss): Promise<void> {
  // batchSize: 3 — max 3 concurrent KB jobs to avoid Bedrock rate limiting
  await boss.work<KBSyncJob>(
    'kb-sync',
    { batchSize: 3 },
    async (jobs) => {
      for (const job of jobs) {
        const { kbId, dsId } = job.data;

        console.log(`[kb-sync] Processing ${job.data.type} for KB=${kbId} DS=${dsId}`);

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

          console.log(`[kb-sync] Done ${job.data.type} KB=${kbId} DS=${dsId} vectors=${vectorKeys.length}`);
        } catch (err) {
          console.error(`[kb-sync] Error ${job.data.type} KB=${kbId} DS=${dsId}:`, err);
          try {
            await updateDS(kbId, dsId, {
              status: 'error',
              lastSyncError: err instanceof Error ? err.message : 'Sync failed',
            });
          } catch (e) {
            console.error('[kb-sync] Error update failed:', e);
          }
          throw err; // Re-throw so pg-boss retries
        }
      }
    },
  );

  console.log('[kb-sync] Registered kb-sync job');
}
