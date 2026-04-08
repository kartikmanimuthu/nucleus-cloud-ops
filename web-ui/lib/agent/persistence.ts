/**
 * persistence.ts
 *
 * Unified singleton for all LangGraph persistence (PostgreSQL only).
 *
 *   - PostgresSaver       → checkpoint state per thread (@langchain/langgraph-checkpoint-postgres)
 *   - PostgresMemoryStore → long-term semantic memory (pgvector + Bedrock embeddings)
 *   - PostgresChatHistory → chat session history (ChatMessage Prisma model)
 *
 * Uses globalThis to survive Next.js hot reloads in dev mode.
 */

import { BedrockEmbeddings } from "@langchain/aws";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { getPrismaClient } from "@/lib/db/pg-config";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ChatHistoryInterface {
    addMessages(tenantId: string, userId: string, threadId: string, messages: Array<{ role: string; content: string; metadata?: Record<string, unknown> }>, sessionToken?: string): Promise<void>;
    getMessages(tenantId: string, userId: string, threadId: string): Promise<Array<{ role: string; content: string; metadata?: Record<string, unknown>; createdAt?: Date }>>;
    clearMessages(tenantId: string, userId: string, threadId: string): Promise<void>;
}

interface MemoryStoreInterface {
    batch(ops: unknown[], config?: unknown): Promise<unknown[]>;
}

interface PersistenceInstances {
    checkpointer: PostgresSaver;
    store: PostgresMemoryStore;
    chatHistory: ChatHistoryInterface;
}

const g = globalThis as unknown as {
    _persistence: PersistenceInstances | undefined;
    _persistencePromise: Promise<PersistenceInstances> | undefined;
};

// ─── PostgreSQL Chat History ──────────────────────────────────────────────────

class PostgresChatHistory implements ChatHistoryInterface {
    async addMessages(
        tenantId: string,
        userId: string,
        threadId: string,
        messages: Array<{ role: string; content: string; metadata?: Record<string, unknown> }>,
        _sessionToken?: string
    ): Promise<void> {
        const prisma = getPrismaClient();
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
        await prisma.chatMessage.createMany({
            data: messages.map((m) => ({
                tenantId: tenantId,
                sessionId: threadId,
                role: m.role,
                content: m.content,
                metadata: m.metadata ?? undefined,
                expiresAt,
            })),
            skipDuplicates: true,
        });
    }

    async getMessages(
        tenantId: string,
        userId: string,
        threadId: string
    ): Promise<Array<{ role: string; content: string; metadata?: Record<string, unknown>; createdAt?: Date }>> {
        const prisma = getPrismaClient();
        const rows = await prisma.chatMessage.findMany({
            where: { tenantId: tenantId, sessionId: threadId },
            orderBy: { createdAt: "asc" },
        });
        return rows.map((r) => ({ role: r.role, content: r.content, metadata: (r.metadata as Record<string, unknown>) ?? undefined, createdAt: r.createdAt }));
    }

    async clearMessages(tenantId: string, userId: string, threadId: string): Promise<void> {
        const prisma = getPrismaClient();
        await prisma.chatMessage.deleteMany({
            where: { tenantId: tenantId, sessionId: threadId },
        });
    }
}

// ─── PostgreSQL Memory Store ──────────────────────────────────────────────────

class PostgresMemoryStore implements MemoryStoreInterface {
    private embeddings: BedrockEmbeddings;

    constructor(embeddings: BedrockEmbeddings) {
        this.embeddings = embeddings;
    }

    async batch(ops: unknown[], _config?: unknown): Promise<unknown[]> {
        const prisma = getPrismaClient();
        const results: unknown[] = [];
        const configurable = (_config as Record<string, unknown>)?.configurable as Record<string, unknown> | undefined;

        for (const op of ops as Array<Record<string, unknown>>) {
            if (op.namespace && op.key && op.value !== undefined) {
                // Put operation
                const namespace = Array.isArray(op.namespace) ? (op.namespace as string[]).join("/") : String(op.namespace);
                const key = String(op.key);
                const value = op.value as Record<string, unknown>;
                const tenantId = configurable?.tenant_id as string ?? "default";
                const userId = configurable?.user_id as string ?? "default";
                const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000); // 90 days

                let embeddingVector: number[] | null = null;
                try {
                    const text = JSON.stringify(value);
                    embeddingVector = await this.embeddings.embedQuery(text);
                } catch {
                    // embedding failure is non-fatal — store without vector
                }

                const embeddingStr = embeddingVector ? `[${embeddingVector.join(",")}]` : null;

                if (embeddingStr) {
                    await prisma.$executeRaw`
                        INSERT INTO agent_memories ("id", "tenantId", "userId", "namespace", "key", "value", "embedding", "createdAt", "updatedAt", "expiresAt")
                        VALUES (gen_random_uuid()::text, ${tenantId}, ${userId}, ${namespace}, ${key}, ${JSON.stringify(value)}::jsonb, ${embeddingStr}::vector, NOW(), NOW(), ${expiresAt})
                        ON CONFLICT ("tenantId", "namespace", "key") DO UPDATE
                        SET "value" = EXCLUDED."value", "embedding" = EXCLUDED."embedding", "updatedAt" = NOW(), "expiresAt" = EXCLUDED."expiresAt"
                    `;
                } else {
                    await prisma.agentMemory.upsert({
                        where: { tenantId_namespace_key: { tenantId: tenantId, namespace, key } },
                        create: { tenantId: tenantId, userId, namespace, key, value, expiresAt },
                        update: { value, expiresAt, updatedAt: new Date() },
                    });
                }
                results.push(null);
            } else if (op.namespacePrefix !== undefined && op.query !== undefined) {
                // Search operation
                const query = String(op.query);
                const limit = Number(op.limit ?? 5);
                const tenantId = configurable?.tenant_id as string ?? "default";

                let queryEmbedding: number[] | null = null;
                try {
                    queryEmbedding = await this.embeddings.embedQuery(query);
                } catch {
                    // fallback to text search
                }

                if (queryEmbedding) {
                    const embeddingStr = `[${queryEmbedding.join(",")}]`;
                    const rows = await prisma.$queryRaw<Array<{ key: string; value: unknown; namespace: string }>>`
                        SELECT "key", "value", "namespace"
                        FROM agent_memories
                        WHERE "tenantId" = ${tenantId}
                        ORDER BY embedding <=> ${embeddingStr}::vector
                        LIMIT ${limit}
                    `;
                    results.push(rows.map((r) => ({ key: r.key, value: r.value, namespace: r.namespace })));
                } else {
                    const rows = await prisma.agentMemory.findMany({
                        where: { tenantId: tenantId },
                        take: limit,
                        orderBy: { createdAt: "desc" },
                    });
                    results.push(rows.map((r) => ({ key: r.key, value: r.value, namespace: r.namespace })));
                }
            } else {
                results.push(null);
            }
        }

        return results;
    }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function initPersistence(): Promise<PersistenceInstances> {
    const region = process.env.AWS_REGION || process.env.NEXT_PUBLIC_AWS_REGION || "us-east-1";
    const databaseUrl = process.env.DATABASE_URL!;

    // PostgresSaver manages its own schema — call setup() on first use
    const checkpointer = PostgresSaver.fromConnString(databaseUrl);
    await checkpointer.setup();

    const embeddings = new BedrockEmbeddings({
        region,
        model: "amazon.titan-embed-text-v2:0",
    });

    const store = new PostgresMemoryStore(embeddings);
    const chatHistory = new PostgresChatHistory();

    console.log("[Persistence] Initialized PostgresSaver, PostgresMemoryStore, PostgresChatHistory");
    return { checkpointer, store, chatHistory };
}

async function getPersistence(): Promise<PersistenceInstances> {
    if (g._persistence) return g._persistence;
    if (!g._persistencePromise) {
        g._persistencePromise = initPersistence()
            .then((p) => {
                g._persistence = p;
                return p;
            })
            .catch((err) => {
                g._persistencePromise = undefined;
                console.error("[Persistence] initPersistence failed:", err);
                throw err;
            });
    }
    return g._persistencePromise;
}

// ─── Getters ──────────────────────────────────────────────────────────────────

export async function getCheckpointer(): Promise<PostgresSaver> {
    return (await getPersistence()).checkpointer;
}

export async function getMemoryStore(): Promise<PostgresMemoryStore> {
    return (await getPersistence()).store;
}

export async function getChatHistory(): Promise<ChatHistoryInterface> {
    return (await getPersistence()).chatHistory;
}

// ─── Memory helpers ───────────────────────────────────────────────────────────

export async function saveMemory(
    tenantId: string,
    userId: string,
    namespace: string[],
    key: string,
    value: Record<string, unknown>
): Promise<void> {
    const store = await getMemoryStore();
    await store.batch(
        [{ namespace, key, value }],
        { configurable: { tenant_id: tenantId, user_id: userId } }
    );
}

export async function searchMemory(
    tenantId: string,
    userId: string,
    namespacePrefix: string[],
    query: string,
    limit = 5
): Promise<unknown[]> {
    const store = await getMemoryStore();
    const [results] = await store.batch(
        [{ namespacePrefix, query, limit }],
        { configurable: { tenant_id: tenantId, user_id: userId } }
    );
    return (results as unknown[]) ?? [];
}
