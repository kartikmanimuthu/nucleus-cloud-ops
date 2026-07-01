import type { Embeddings } from '@langchain/core/embeddings';
import { Prisma } from '@prisma/client';
import { getPrismaClient } from '@/lib/db/pg-config';
import { getTenantEmbeddings } from '../embeddings-factory';
import type { MemoryHit, MemoryKind, WorkingMemory, Scratchpad } from './types';

export interface RecallParams {
    tenantId: string;
    userId: string;
    query: string;
    kinds?: MemoryKind[];
    namespacePrefix?: string[];
    limit?: number;
}
export interface RememberParams {
    tenantId: string;
    userId: string;
    kind: MemoryKind;
    namespace: string[];
    key: string;
    value: Record<string, unknown>;
    sourceThreadId?: string;
}
export interface PutWorkingMemoryParams {
    tenantId: string;
    threadId: string;
    wm: WorkingMemory;
}

const TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days, matches existing memory TTL

export class MemoryService {
    private embeddingsCache = new Map<string, Promise<Embeddings>>();

    private getEmbeddings(tenantId: string): Promise<Embeddings> {
        let cached = this.embeddingsCache.get(tenantId);
        if (!cached) {
            cached = getTenantEmbeddings(tenantId);
            cached.catch(() => this.embeddingsCache.delete(tenantId));
            this.embeddingsCache.set(tenantId, cached);
        }
        return cached;
    }

    async remember(m: RememberParams): Promise<void> {
        const prisma = getPrismaClient();
        const namespace = m.namespace.join('/');
        const expiresAt = new Date(Date.now() + TTL_MS);

        let vec: number[] | null = null;
        try {
            const emb = await this.getEmbeddings(m.tenantId);
            vec = await emb.embedQuery(JSON.stringify(m.value));
        } catch {
            // provider missing / embedding failure is non-fatal
        }

        if (vec) {
            const vecStr = `[${vec.join(',')}]`;
            // $executeRaw is NOT tenant-intercepted — tenantId is bound explicitly.
            await prisma.$executeRaw`
                INSERT INTO agent_memories ("id","tenantId","userId","namespace","key","value","kind","embedding","sourceThreadId","createdAt","updatedAt","expiresAt")
                VALUES (gen_random_uuid()::text, ${m.tenantId}, ${m.userId}, ${namespace}, ${m.key}, ${JSON.stringify(m.value)}::jsonb, ${m.kind}::"MemoryKind", ${vecStr}::vector, ${m.sourceThreadId ?? null}, NOW(), NOW(), ${expiresAt})
                ON CONFLICT ("tenantId","namespace","key") DO UPDATE
                SET "value" = EXCLUDED."value", "kind" = EXCLUDED."kind", "embedding" = EXCLUDED."embedding", "updatedAt" = NOW(), "expiresAt" = EXCLUDED."expiresAt"
            `;
        } else {
            await prisma.agentMemory.upsert({
                where: { tenantId_namespace_key: { tenantId: m.tenantId, namespace, key: m.key } },
                create: { tenantId: m.tenantId, userId: m.userId, namespace, key: m.key, value: m.value as Prisma.InputJsonValue, kind: m.kind, sourceThreadId: m.sourceThreadId ?? null, expiresAt },
                update: { value: m.value as Prisma.InputJsonValue, kind: m.kind, expiresAt, updatedAt: new Date() },
            });
        }
    }

    async recall(p: RecallParams): Promise<MemoryHit[]> {
        const prisma = getPrismaClient();
        const limit = p.limit ?? 5;
        const nsPrefix = (p.namespacePrefix ?? []).join('/');
        const kinds = p.kinds ?? [];

        let queryVec: number[] | null = null;
        try {
            const emb = await this.getEmbeddings(p.tenantId);
            queryVec = await emb.embedQuery(p.query);
        } catch {
            // fall through to recency search
        }

        // Build the kind filter as a parameter list; empty => all kinds.
        const kindList = kinds.length ? kinds : null;

        let rows: Array<{ namespace: string; key: string; value: unknown; kind: MemoryKind }>;
        if (queryVec) {
            const vecStr = `[${queryVec.join(',')}]`;
            rows = await prisma.$queryRaw<Array<{ namespace: string; key: string; value: unknown; kind: MemoryKind }>>`
                SELECT "namespace","key","value","kind"
                FROM agent_memories
                WHERE "tenantId" = ${p.tenantId}
                  AND "supersededById" IS NULL
                  AND (${nsPrefix} = '' OR "namespace" LIKE ${nsPrefix + '%'})
                  AND (${kindList}::text[] IS NULL OR "kind"::text = ANY(${kindList}::text[]))
                ORDER BY embedding <=> ${vecStr}::vector
                LIMIT ${limit}
            `;
        } else {
            rows = await prisma.$queryRaw<Array<{ namespace: string; key: string; value: unknown; kind: MemoryKind }>>`
                SELECT "namespace","key","value","kind"
                FROM agent_memories
                WHERE "tenantId" = ${p.tenantId}
                  AND "supersededById" IS NULL
                  AND (${nsPrefix} = '' OR "namespace" LIKE ${nsPrefix + '%'})
                  AND (${kindList}::text[] IS NULL OR "kind"::text = ANY(${kindList}::text[]))
                ORDER BY "createdAt" DESC
                LIMIT ${limit}
            `;
        }

        // Reinforcement signal — best-effort, non-blocking.
        const keys = rows.map((r) => r.key);
        if (keys.length) {
            prisma.$executeRaw`
                UPDATE agent_memories SET "lastAccessedAt" = NOW(), "accessCount" = "accessCount" + 1
                WHERE "tenantId" = ${p.tenantId} AND "key" = ANY(${keys}::text[])
            `.catch(() => {});
        }

        return rows.map((r) => ({
            namespace: r.namespace,
            key: r.key,
            value: (r.value ?? {}) as Record<string, unknown>,
            kind: r.kind,
        }));
    }

    async getWorkingMemory(tenantId: string, threadId: string): Promise<WorkingMemory | null> {
        const prisma = getPrismaClient();
        const row = await prisma.agentWorkingMemory.findUnique({
            where: { tenantId_threadId: { tenantId, threadId } },
        });
        if (!row) return null;
        return {
            runningSummary: row.runningSummary,
            scratchpad: (row.scratchpad ?? {}) as unknown as Scratchpad,
            tokenCount: row.tokenCount,
            turnCount: row.turnCount,
        };
    }

    async putWorkingMemory(p: PutWorkingMemoryParams): Promise<void> {
        const prisma = getPrismaClient();
        const expiresAt = new Date(Date.now() + TTL_MS);
        await prisma.agentWorkingMemory.upsert({
            where: { tenantId_threadId: { tenantId: p.tenantId, threadId: p.threadId } },
            create: {
                tenantId: p.tenantId, threadId: p.threadId,
                runningSummary: p.wm.runningSummary,
                scratchpad: p.wm.scratchpad as unknown as object,
                tokenCount: p.wm.tokenCount, turnCount: p.wm.turnCount, expiresAt,
            },
            update: {
                runningSummary: p.wm.runningSummary,
                scratchpad: p.wm.scratchpad as unknown as object,
                tokenCount: p.wm.tokenCount, turnCount: p.wm.turnCount,
                expiresAt, updatedAt: new Date(),
            },
        });
    }
}

let _service: MemoryService | undefined;
export function getMemoryService(): MemoryService {
    if (!_service) _service = new MemoryService();
    return _service;
}
