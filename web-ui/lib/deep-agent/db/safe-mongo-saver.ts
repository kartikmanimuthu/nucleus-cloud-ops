// ============================================================================
// SafeMongoDBSaver — Wraps MongoDBSaver to guard against empty bulkWrite calls
// and add detailed checkpoint event logging.
//
// The upstream MongoDBSaver.putWrites() does a bulkWrite even when writes is
// empty, which throws: "Invalid BulkOperation, Batch cannot be empty".
// This subclass guards that edge case and logs all checkpoint activity.
// ============================================================================

import { MongoDBSaver } from '@langchain/langgraph-checkpoint-mongodb';
import type { MongoClient } from 'mongodb';
import type { CheckpointMetadata, PendingWrite } from '@langchain/langgraph-checkpoint';
import { createLogger } from '../logger';

const log = createLogger('SafeMongoDBSaver');

interface SafeMongoDBSaverOptions {
    client: MongoClient;
    dbName: string;
    checkpointCollectionName?: string;
    checkpointWritesCollectionName?: string;
}

export class SafeMongoDBSaver extends MongoDBSaver {
    constructor(options: SafeMongoDBSaverOptions) {
        super(options as any);
        log.info('SafeMongoDBSaver initialised', {
            db: options.dbName,
            checkpoints: options.checkpointCollectionName ?? 'checkpoints',
            writes: options.checkpointWritesCollectionName ?? 'checkpoint_writes',
        });
    }

    /**
     * Override getTuple to log checkpoint reads.
     */
    async getTuple(config: Parameters<MongoDBSaver['getTuple']>[0]) {
        const threadId = (config as any)?.configurable?.thread_id ?? 'unknown';
        const checkpointId = (config as any)?.configurable?.checkpoint_id;
        log.debug('getTuple → loading checkpoint', { threadId, checkpointId });

        const result = await super.getTuple(config);
        if (result) {
            log.info('getTuple → checkpoint found', {
                threadId,
                checkpointId: result.checkpoint?.id ?? checkpointId,
                channel_count: Object.keys(result.checkpoint?.channel_values ?? {}).length,
            });
        } else {
            log.info('getTuple → no checkpoint found (new thread or first run)', { threadId });
        }
        return result;
    }

    /**
     * Override list to log checkpoint listing queries.
     */
    async *list(
        config: Parameters<MongoDBSaver['list']>[0],
        options?: Parameters<MongoDBSaver['list']>[1],
    ) {
        const threadId = (config as any)?.configurable?.thread_id ?? 'unknown';
        log.debug('list → querying checkpoints', {
            threadId,
            limit: (options as any)?.limit,
            before: (options as any)?.before,
        });
        let count = 0;
        for await (const cp of super.list(config, options)) {
            count++;
            log.debug('list → checkpoint entry', {
                threadId,
                checkpointId: cp.checkpoint?.id,
                ts: cp.checkpoint?.ts,
            });
            yield cp;
        }
        log.debug('list → done', { threadId, total: count });
    }

    /**
     * Override put to log checkpoint writes.
     */
    async put(
        config: Parameters<MongoDBSaver['put']>[0],
        checkpoint: Parameters<MongoDBSaver['put']>[1],
        metadata: CheckpointMetadata,
    ) {
        const threadId = (config as any)?.configurable?.thread_id ?? 'unknown';
        log.info('put → persisting checkpoint', {
            threadId,
            checkpointId: checkpoint.id,
            ts: checkpoint.ts,
            step: (metadata as any)?.step,
            source: (metadata as any)?.source,
            channel_count: Object.keys(checkpoint.channel_values ?? {}).length,
        });

        const result = await super.put(config, checkpoint, metadata);
        log.debug('put → checkpoint persisted', { threadId, checkpointId: checkpoint.id });
        return result;
    }

    /**
     * Override putWrites to skip the bulkWrite when there are no writes,
     * and log all write events.
     * The upstream does not guard this, causing "Invalid BulkOperation, Batch cannot be empty".
     */
    async putWrites(
        config: Parameters<MongoDBSaver['putWrites']>[0],
        writes: PendingWrite[],
        taskId: string,
    ): Promise<void> {
        const threadId = (config as any)?.configurable?.thread_id ?? 'unknown';

        if (!writes || writes.length === 0) {
            log.debug('putWrites → skipped (empty writes array)', { threadId, taskId });
            return; // guard: nothing to persist
        }

        log.info('putWrites → persisting writes', {
            threadId,
            taskId,
            writeCount: writes.length,
            channels: writes.map(w => w[0]),
        });

        try {
            await super.putWrites(config, writes, taskId);
            log.debug('putWrites → writes persisted', { threadId, taskId, writeCount: writes.length });
        } catch (err: any) {
            log.error('putWrites → failed', {
                threadId,
                taskId,
                writeCount: writes.length,
                error: err.message,
            });
            throw err;
        }
    }
}
