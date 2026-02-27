// ============================================================================
// Deep Agent Module — MongoDB-backed BaseStore for Long-Term Memory
//
// Implements the LangGraph @langchain/langgraph BaseStore interface so it can
// be passed directly to createDeepAgent({ store }) as the production long-term
// memory backend (instead of InMemoryStore).
//
// Files written to /memories/* are stored in this store (cross-thread).
// Files without that prefix stay in StateBackend (thread-scoped).
// ============================================================================

import { getDb } from './mongo-client';
import { createLogger } from '../logger';

const log = createLogger('MongoStore');
const COLLECTION = 'memory_store';

interface StoredItem {
    namespace: string[];
    key: string;
    value: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
}

type NSKey = string;

function nsKey(namespace: string[]): NSKey {
    return namespace.join('::');
}

export class MongoStore {
    private initialized = false;

    private async getCollection() {
        const db = await getDb();
        const col = db.collection<StoredItem>(COLLECTION);
        if (!this.initialized) {
            log.debug('Creating unique index on (namespace, key)');
            await col.createIndex({ namespace: 1, key: 1 }, { unique: true });
            this.initialized = true;
            log.info('MongoStore collection ready', { collection: COLLECTION });
        }
        return col;
    }

    async get(namespace: string[], key: string): Promise<Record<string, unknown> | null> {
        const ns = nsKey(namespace);
        log.debug('get', { namespace: ns, key });
        const col = await this.getCollection();
        const doc = await col.findOne({ namespace: ns as any, key });
        if (doc) {
            log.debug('get → hit', { namespace: ns, key, valueKeys: Object.keys(doc.value) });
        } else {
            log.debug('get → miss', { namespace: ns, key });
        }
        return doc?.value ?? null;
    }

    async put(namespace: string[], key: string, value: Record<string, unknown>): Promise<void> {
        const ns = nsKey(namespace);
        log.info('put', { namespace: ns, key, valueKeys: Object.keys(value) });
        const col = await this.getCollection();
        const now = new Date().toISOString();
        try {
            await col.updateOne(
                { namespace: ns as any, key },
                {
                    $set: { value, updatedAt: now },
                    $setOnInsert: { namespace: ns as any, key, createdAt: now },
                },
                { upsert: true },
            );
            log.debug('put → upserted', { namespace: ns, key });
        } catch (err: any) {
            log.error('put → failed', { namespace: ns, key, error: err.message });
            throw err;
        }
    }

    async delete(namespace: string[], key: string): Promise<void> {
        const ns = nsKey(namespace);
        log.info('delete', { namespace: ns, key });
        const col = await this.getCollection();
        try {
            const result = await col.deleteOne({ namespace: ns as any, key });
            log.debug('delete → done', { namespace: ns, key, deleted: result.deletedCount });
        } catch (err: any) {
            log.error('delete → failed', { namespace: ns, key, error: err.message });
            throw err;
        }
    }

    async search(namespace: string[]): Promise<Array<{ key: string; value: Record<string, unknown> }>> {
        const ns = nsKey(namespace);
        log.debug('search', { namespace: ns });
        const col = await this.getCollection();
        const docs = await col.find({ namespace: ns as any }).toArray();
        log.debug('search → results', { namespace: ns, count: docs.length, keys: docs.map(d => d.key) });
        return docs.map(d => ({ key: d.key, value: d.value }));
    }

    // -------------------------------------------------------------------------
    // LangGraph BaseStore interface compatibility shims
    // -------------------------------------------------------------------------

    async getMany(
        keys: Array<{ namespace: string[]; key: string }>,
    ): Promise<Array<Record<string, unknown> | null>> {
        log.debug('getMany', { count: keys.length, keys: keys.map(k => `${nsKey(k.namespace)}::${k.key}`) });
        return Promise.all(keys.map(k => this.get(k.namespace, k.key)));
    }

    async putMany(
        items: Array<{ namespace: string[]; key: string; value: Record<string, unknown> }>,
    ): Promise<void> {
        log.info('putMany', { count: items.length, keys: items.map(i => `${nsKey(i.namespace)}::${i.key}`) });
        await Promise.all(items.map(i => this.put(i.namespace, i.key, i.value)));
    }

    async deleteMany(items: Array<{ namespace: string[]; key: string }>): Promise<void> {
        log.info('deleteMany', { count: items.length });
        await Promise.all(items.map(i => this.delete(i.namespace, i.key)));
    }

    async list(namespace: string[]): Promise<string[]> {
        log.debug('list', { namespace: nsKey(namespace) });
        const items = await this.search(namespace);
        return items.map(i => i.key);
    }

    async batch(operations: any[]): Promise<any[]> {
        log.debug('batch', { operationCount: operations.length });

        const results: any[] = [];
        for (const [i, op] of operations.entries()) {
            if ('key' in op && 'namespace' in op && !('value' in op)) {
                // getOperation
                log.debug(`batch[${i}] getOperation`, { namespace: nsKey(op.namespace), key: op.key });
                results.push(await this.get(op.namespace, op.key));
            } else if ('namespacePrefix' in op) {
                // searchOperation
                log.debug(`batch[${i}] searchOperation`, { namespacePrefix: nsKey(op.namespacePrefix) });
                const items = await this.search(op.namespacePrefix);
                const returnedItems = items.map(item => ({
                    namespace: op.namespacePrefix,
                    key: item.key,
                    value: item.value,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                }));
                log.debug(`batch[${i}] searchOperation → ${returnedItems.length} results`);
                results.push(returnedItems);
            } else if ('value' in op) {
                // putOperation
                log.debug(`batch[${i}] putOperation`, { namespace: nsKey(op.namespace), key: op.key });
                await this.put(op.namespace, op.key, op.value);
                results.push(null);
            } else if ('matchConditions' in op) {
                // listNamespacesOperation
                log.debug(`batch[${i}] listNamespacesOperation`);
                results.push([op.matchConditions[0].match.join(':')]);
            } else {
                log.warn(`batch[${i}] unknown operation type`, { op });
                results.push(null);
            }
        }

        log.debug('batch → complete', { operationCount: operations.length, resultCount: results.length });
        return results;
    }
}

// Singleton instance (hot-reload safe)
const globalForStore = globalThis as unknown as { deepAgentMongoStore: MongoStore | undefined };
if (!globalForStore.deepAgentMongoStore) {
    globalForStore.deepAgentMongoStore = new MongoStore();
}
export const mongoStore = globalForStore.deepAgentMongoStore!;
