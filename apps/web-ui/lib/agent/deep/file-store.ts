import { BaseStore, type Operation, type OperationResults, type Item } from '@langchain/langgraph';
import { getPrismaClient } from '@/lib/db/pg-config';

/**
 * BaseStore over the agent_files table, for the deep agent's StoreBackend.
 *
 * BaseStore implements get/put/search/delete in terms of batch(), so batch() is the only
 * method that needs writing. Rows are keyed by (tenantId, namespace, key) and carry no
 * embedding and no TTL — this is file storage, not semantic memory, and it must never
 * appear in similarity recall.
 */
export class PostgresFileStore extends BaseStore {
    constructor(private readonly tenantId: string) {
        super();
    }

    async batch<Op extends Operation[]>(operations: Op): Promise<OperationResults<Op>> {
        const db = getPrismaClient();
        const results: unknown[] = [];

        for (const op of operations) {
            const o = op as unknown as Record<string, unknown>;
            const namespace = Array.isArray(o.namespace) ? (o.namespace as string[]).join('/') : undefined;

            if (o.value !== undefined && o.value !== null && namespace !== undefined && o.key !== undefined) {
                await db.agentFile.upsert({
                    where: { tenantId_namespace_key: { tenantId: this.tenantId, namespace, key: String(o.key) } },
                    create: { tenantId: this.tenantId, namespace, key: String(o.key), value: o.value as object },
                    update: { value: o.value as object },
                });
                results.push(undefined);
            } else if (o.value === null && namespace !== undefined && o.key !== undefined) {
                await db.agentFile.deleteMany({ where: { tenantId: this.tenantId, namespace, key: String(o.key) } });
                results.push(undefined);
            } else if (namespace !== undefined && o.key !== undefined) {
                const row = await db.agentFile.findUnique({
                    where: { tenantId_namespace_key: { tenantId: this.tenantId, namespace, key: String(o.key) } },
                });
                results.push(row ? this.toItem(row) : null);
            } else if (o.namespacePrefix !== undefined) {
                const prefix = (o.namespacePrefix as string[]).join('/');
                const rows = await db.agentFile.findMany({
                    where: { tenantId: this.tenantId, namespace: { startsWith: prefix } },
                    take: typeof o.limit === 'number' ? o.limit : 100,
                    skip: typeof o.offset === 'number' ? o.offset : 0,
                    orderBy: { updatedAt: 'desc' },
                });
                results.push(rows.map(r => this.toItem(r)));
            } else if (o.matchConditions !== undefined || o.maxDepth !== undefined) {
                const rows = await db.agentFile.findMany({
                    where: { tenantId: this.tenantId },
                    select: { namespace: true },
                    distinct: ['namespace'],
                });
                results.push(rows.map(r => r.namespace.split('/')));
            } else {
                results.push(null);
            }
        }

        return results as OperationResults<Op>;
    }

    private toItem(row: { namespace: string; key: string; value: unknown; createdAt: Date; updatedAt: Date }): Item {
        return {
            namespace: row.namespace.split('/'),
            key: row.key,
            value: row.value as Record<string, unknown>,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
        };
    }
}
