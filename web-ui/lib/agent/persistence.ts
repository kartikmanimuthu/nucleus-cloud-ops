/**
 * persistence.ts
 *
 * Unified singleton for all LangGraph persistence:
 *   - DynamoDBSaver       → short-term memory (checkpoint state per thread)
 *   - DynamoDBStore       → long-term memory (cross-session, semantic search via Bedrock)
 *   - DynamoDBChatMessageHistory → chat session history
 *
 * Uses globalThis to survive Next.js hot reloads in dev mode.
 */

import {
    DynamoDBSaver,
    DynamoDBStore,
    DynamoDBChatMessageHistory,
} from "@farukada/aws-langgraph-dynamodb-ts";
import { BedrockEmbeddings } from "@langchain/aws";

// ─── Types ───────────────────────────────────────────────────────────────────

interface PersistenceInstances {
    checkpointer: DynamoDBSaver;
    store: DynamoDBStore;
    chatHistory: DynamoDBChatMessageHistory;
}

const g = globalThis as unknown as {
    _persistence: PersistenceInstances | undefined;
    _persistencePromise: Promise<PersistenceInstances> | undefined;
};

// ─── Init ─────────────────────────────────────────────────────────────────────

async function initPersistence(): Promise<PersistenceInstances> {
    const region = process.env.AWS_REGION || process.env.NEXT_PUBLIC_AWS_REGION || "us-east-1";

    const checkpointsTableName = process.env.DYNAMODB_CHECKPOINT_TABLE!;
    const writesTableName = process.env.DYNAMODB_WRITES_TABLE!;
    const chatHistoryTableName = process.env.DYNAMODB_CHAT_HISTORY_TABLE!;
    const memoryTableName = process.env.DYNAMODB_MEMORY_TABLE!;

    const clientConfig = { region };

    const bucketName = process.env.CHECKPOINT_S3_BUCKET;

    const checkpointer = new DynamoDBSaver({
        checkpointsTableName,
        writesTableName,
        ttlDays: 30,
        compression: { enabled: true, minSizeBytes: 1024 },
        ...(bucketName && {
            s3OffloadConfig: {
                bucketName,
                keyPrefix: "langgraph/checkpoints/",
            },
        }),
        clientConfig,
    });

    const store = new DynamoDBStore({
        memoryTableName,
        ttlDays: 90,
        clientConfig,
        embedding: new BedrockEmbeddings({
            region,
            model: "amazon.titan-embed-text-v2:0",
        }),
    });

    // Note: ttlDays is intentionally omitted here.
    // The library uses 'ttl' (a DynamoDB reserved keyword) directly in its SET expression
    // without ExpressionAttributeNames escaping, which causes a ValidationException.
    // TTL on individual message items is still set correctly via transactWrite Put operations.
    const chatHistory = new DynamoDBChatMessageHistory({
        tableName: chatHistoryTableName,
        clientConfig,
    });

    console.log("[Persistence] Initialized DynamoDBSaver, DynamoDBStore, DynamoDBChatMessageHistory");
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
                // Clear the cached rejection so the next call retries
                g._persistencePromise = undefined;
                console.error("[Persistence] initPersistence failed:", err);
                throw err;
            });
    }
    return g._persistencePromise;
}

// ─── Getters ──────────────────────────────────────────────────────────────────

export async function getCheckpointer(): Promise<DynamoDBSaver> {
    return (await getPersistence()).checkpointer;
}

export async function getMemoryStore(): Promise<DynamoDBStore> {
    return (await getPersistence()).store;
}

export async function getChatHistory(): Promise<DynamoDBChatMessageHistory> {
    return (await getPersistence()).chatHistory;
}

// ─── Memory helpers ───────────────────────────────────────────────────────────

export async function saveMemory(
    userId: string,
    namespace: string[],
    key: string,
    value: Record<string, unknown>
): Promise<void> {
    const store = await getMemoryStore();
    await store.batch(
        [{ namespace, key, value }],
        { configurable: { user_id: userId } }
    );
}

export async function searchMemory(
    userId: string,
    namespacePrefix: string[],
    query: string,
    limit = 5
): Promise<unknown[]> {
    const store = await getMemoryStore();
    const [results] = await store.batch(
        [{ namespacePrefix, query, limit }],
        { configurable: { user_id: userId } }
    );
    return (results as unknown[]) ?? [];
}
