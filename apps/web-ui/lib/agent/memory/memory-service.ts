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

    async remember(m: RememberParams): Promise<string> {
        const prisma = getPrismaClient();
        const namespace = m.namespace.join('/');
        const expiresAt = new Date(Date.now() + TTL_MS);

        let vec: number[] | null = null;
        try {
            const emb = await this.getEmbeddings(m.tenantId);
            vec = await emb.embedQuery(JSON.stringify(m.value));
        } catch (err) {
            // Provider missing / embedding failure is non-fatal: the memory is still
            // stored (below, via the null-embedding ORM path), so recency recall can
            // surface it — but it is unreachable by vector similarity search until
            // re-embedded. Surface it at warn level with tenant context.
            console.warn(
                `[MemoryService] Embedding failed for tenant=${m.tenantId} namespace=${m.namespace.join('/')} key=${m.key} — storing without embedding (vector recall will miss it): ${(err as { message?: string })?.message ?? err}`,
            );
        }

        if (vec) {
            const vecStr = `[${vec.join(',')}]`;
            // $queryRaw is NOT tenant-intercepted — tenantId is bound explicitly.
            // The conflict target names the PARTIAL unique index (live rows only), so a
            // superseded row with the same key never blocks inserting its successor.
            const rows = await prisma.$queryRaw<Array<{ id: string }>>`
                INSERT INTO agent_memories ("id","tenantId","userId","namespace","key","value","kind","embedding","sourceThreadId","createdAt","updatedAt","expiresAt")
                VALUES (gen_random_uuid()::text, ${m.tenantId}, ${m.userId}, ${namespace}, ${m.key}, ${JSON.stringify(m.value)}::jsonb, ${m.kind}::"MemoryKind", ${vecStr}::vector, ${m.sourceThreadId ?? null}, NOW(), NOW(), ${expiresAt})
                ON CONFLICT ("tenantId","namespace","key") WHERE "supersededById" IS NULL DO UPDATE
                SET "value" = EXCLUDED."value", "kind" = EXCLUDED."kind", "embedding" = EXCLUDED."embedding", "updatedAt" = NOW(), "expiresAt" = EXCLUDED."expiresAt"
                RETURNING "id"
            `;
            return rows[0].id;
        }

        // No embedding — ORM fallback. The compound unique no longer exists in the Prisma
        // schema (the partial unique index is SQL-only), so upsert is replaced by
        // find-live-then-update/create, with a one-shot retry if a concurrent create wins
        // the race (the partial unique index is the backstop; Prisma maps 23505 → P2002).
        const live = await prisma.agentMemory.findFirst({
            where: { tenantId: m.tenantId, namespace, key: m.key, supersededById: null },
            select: { id: true },
        });
        if (live) {
            await prisma.agentMemory.updateMany({
                where: { id: live.id, tenantId: m.tenantId },
                data: { value: m.value as Prisma.InputJsonValue, kind: m.kind, expiresAt, updatedAt: new Date() },
            });
            return live.id;
        }
        try {
            const created = await prisma.agentMemory.create({
                data: { tenantId: m.tenantId, userId: m.userId, namespace, key: m.key, value: m.value as Prisma.InputJsonValue, kind: m.kind, sourceThreadId: m.sourceThreadId ?? null, expiresAt },
            });
            return created.id;
        } catch (err) {
            if ((err as { code?: string })?.code === 'P2002') {
                const winner = await prisma.agentMemory.findFirst({
                    where: { tenantId: m.tenantId, namespace, key: m.key, supersededById: null },
                    select: { id: true },
                });
                if (winner) {
                    await prisma.agentMemory.updateMany({
                        where: { id: winner.id, tenantId: m.tenantId },
                        data: { value: m.value as Prisma.InputJsonValue, kind: m.kind, expiresAt, updatedAt: new Date() },
                    });
                    return winner.id;
                }
            }
            throw err;
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

        let rows: Array<{ id: string; namespace: string; key: string; value: unknown; kind: MemoryKind; distance: number | null }>;
        if (queryVec) {
            const vecStr = `[${queryVec.join(',')}]`;
            rows = await prisma.$queryRaw<Array<{ id: string; namespace: string; key: string; value: unknown; kind: MemoryKind; distance: number | null }>>`
                SELECT "id","namespace","key","value","kind", (embedding <=> ${vecStr}::vector) AS distance
                FROM agent_memories
                WHERE "tenantId" = ${p.tenantId}
                  AND "supersededById" IS NULL
                  AND "expiresAt" > NOW()
                  AND (${nsPrefix} = '' OR "namespace" LIKE ${nsPrefix + '%'})
                  AND (${kindList}::text[] IS NULL OR "kind"::text = ANY(${kindList}::text[]))
                ORDER BY embedding <=> ${vecStr}::vector
                LIMIT ${limit}
            `;
        } else {
            rows = await prisma.$queryRaw<Array<{ id: string; namespace: string; key: string; value: unknown; kind: MemoryKind; distance: number | null }>>`
                SELECT "id","namespace","key","value","kind", NULL::float8 AS distance
                FROM agent_memories
                WHERE "tenantId" = ${p.tenantId}
                  AND "supersededById" IS NULL
                  AND "expiresAt" > NOW()
                  AND (${nsPrefix} = '' OR "namespace" LIKE ${nsPrefix + '%'})
                  AND (${kindList}::text[] IS NULL OR "kind"::text = ANY(${kindList}::text[]))
                ORDER BY "createdAt" DESC
                LIMIT ${limit}
            `;
        }

        // Reinforcement signal — best-effort, non-blocking. Bump ONLY the rows actually
        // recalled (by id), not every row sharing a key string: a key like "prod-region"
        // recurs across namespaces and superseded rows, and skill-synthesis matures rules
        // at accessCount >= threshold, so a key-scoped UPDATE would inflate maturity.
        const ids = rows.map((r) => r.id);
        if (ids.length) {
            prisma.$executeRaw`
                UPDATE agent_memories SET "lastAccessedAt" = NOW(), "accessCount" = "accessCount" + 1
                WHERE "tenantId" = ${p.tenantId} AND "id" = ANY(${ids}::text[])
            `.catch(() => {});
        }

        return rows.map((r) => ({
            id: r.id,
            namespace: r.namespace,
            key: r.key,
            value: (r.value ?? {}) as Record<string, unknown>,
            kind: r.kind,
            ...(r.distance !== null && r.distance !== undefined ? { distance: Number(r.distance) } : {}),
        }));
    }

    /** Replace a memory's value in place (judge UPDATE). Re-embeds; embed failure keeps the old vector. */
    async update(tenantId: string, id: string, value: Record<string, unknown>): Promise<void> {
        const prisma = getPrismaClient();
        const expiresAt = new Date(Date.now() + TTL_MS);
        let vec: number[] | null = null;
        try {
            const emb = await this.getEmbeddings(tenantId);
            vec = await emb.embedQuery(JSON.stringify(value));
        } catch {
            // keep the old embedding
        }
        if (vec) {
            const vecStr = `[${vec.join(',')}]`;
            await prisma.$executeRaw`
                UPDATE agent_memories
                SET "value" = ${JSON.stringify(value)}::jsonb, "embedding" = ${vecStr}::vector, "updatedAt" = NOW(), "expiresAt" = ${expiresAt}
                WHERE "id" = ${id} AND "tenantId" = ${tenantId}
            `;
        } else {
            await prisma.agentMemory.updateMany({
                where: { id, tenantId },
                data: { value: value as Prisma.InputJsonValue, expiresAt, updatedAt: new Date() },
            });
        }
    }

    /** Mark `oldId` as displaced by `newId` (judge SUPERSEDE). Old row is never deleted. */
    async supersede(tenantId: string, oldId: string, newId: string): Promise<void> {
        const prisma = getPrismaClient();
        await prisma.agentMemory.updateMany({
            where: { id: oldId, tenantId },
            data: { supersededById: newId, supersededAt: new Date(), updatedAt: new Date() },
        });
    }

    /** A duplicate re-confirmed this memory (judge REINFORCE): refresh TTL, bump the signal. */
    async reinforce(tenantId: string, id: string): Promise<void> {
        const prisma = getPrismaClient();
        await prisma.agentMemory.updateMany({
            where: { id, tenantId },
            data: { expiresAt: new Date(Date.now() + TTL_MS), accessCount: { increment: 1 }, lastAccessedAt: new Date(), updatedAt: new Date() },
        });
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
