/**
 * persistence.test.ts
 *
 * TDD unit tests for persistence.ts — verifies both DynamoDB and PostgreSQL
 * backends are selected correctly based on USE_PG_LANGGRAPH feature flag.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@farukada/aws-langgraph-dynamodb-ts", () => ({
    DynamoDBSaver: vi.fn(function() { return { type: "DynamoDBSaver" }; }),
    DynamoDBStore: vi.fn(function() { return { type: "DynamoDBStore", batch: vi.fn().mockResolvedValue([[]]) }; }),
    DynamoDBChatMessageHistory: vi.fn(function() { return { type: "DynamoDBChatMessageHistory" }; }),
}));

vi.mock("@langchain/langgraph-checkpoint-postgres", () => ({
    PostgresSaver: {
        fromConnString: vi.fn().mockReturnValue({
            type: "PostgresSaver",
            setup: vi.fn().mockResolvedValue(undefined),
        }),
    },
}));

vi.mock("@langchain/aws", () => ({
    BedrockEmbeddings: vi.fn(function() {
        return { embedQuery: vi.fn().mockResolvedValue(new Array(1024).fill(0.1)) };
    }),
}));

vi.mock("@/lib/db/pg-config", () => ({
    getPrismaClient: vi.fn().mockReturnValue({
        chatMessage: {
            createMany: vi.fn().mockResolvedValue({ count: 0 }),
            findMany: vi.fn().mockResolvedValue([]),
            deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        agentMemory: {
            upsert: vi.fn().mockResolvedValue({}),
            findMany: vi.fn().mockResolvedValue([]),
        },
        $executeRaw: vi.fn().mockResolvedValue(0),
        $queryRaw: vi.fn().mockResolvedValue([]),
    }),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clearPersistenceSingleton() {
    const g = globalThis as Record<string, unknown>;
    delete g._persistence;
    delete g._persistencePromise;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("persistence module", () => {
    beforeEach(() => {
        clearPersistenceSingleton();
        vi.clearAllMocks();
    });

    afterEach(() => {
        clearPersistenceSingleton();
        vi.unstubAllEnvs();
    });

    describe("DynamoDB backend (USE_PG_LANGGRAPH unset/false)", () => {
        it("getCheckpointer() returns DynamoDBSaver when USE_PG_LANGGRAPH is not set", async () => {
            vi.stubEnv("USE_PG_LANGGRAPH", "");
            vi.stubEnv("DYNAMODB_CHECKPOINT_TABLE", "test-checkpoints");
            vi.stubEnv("DYNAMODB_WRITES_TABLE", "test-writes");
            vi.stubEnv("DYNAMODB_CHAT_HISTORY_TABLE", "test-chat");
            vi.stubEnv("DYNAMODB_MEMORY_TABLE", "test-memory");

            const { getCheckpointer } = await import("./persistence");
            const checkpointer = await getCheckpointer();
            expect((checkpointer as { type: string }).type).toBe("DynamoDBSaver");
        });

        it("getCheckpointer() returns DynamoDBSaver when USE_PG_LANGGRAPH=false", async () => {
            vi.stubEnv("USE_PG_LANGGRAPH", "false");
            vi.stubEnv("DYNAMODB_CHECKPOINT_TABLE", "test-checkpoints");
            vi.stubEnv("DYNAMODB_WRITES_TABLE", "test-writes");
            vi.stubEnv("DYNAMODB_CHAT_HISTORY_TABLE", "test-chat");
            vi.stubEnv("DYNAMODB_MEMORY_TABLE", "test-memory");

            const { getCheckpointer } = await import("./persistence");
            const checkpointer = await getCheckpointer();
            expect((checkpointer as { type: string }).type).toBe("DynamoDBSaver");
        });

        it("getChatHistory() returns DynamoDBChatMessageHistory when USE_PG_LANGGRAPH is false", async () => {
            vi.stubEnv("USE_PG_LANGGRAPH", "false");
            vi.stubEnv("DYNAMODB_CHECKPOINT_TABLE", "test-checkpoints");
            vi.stubEnv("DYNAMODB_WRITES_TABLE", "test-writes");
            vi.stubEnv("DYNAMODB_CHAT_HISTORY_TABLE", "test-chat");
            vi.stubEnv("DYNAMODB_MEMORY_TABLE", "test-memory");

            const { getChatHistory } = await import("./persistence");
            const history = await getChatHistory();
            expect((history as { type: string }).type).toBe("DynamoDBChatMessageHistory");
        });

        it("getMemoryStore() returns DynamoDBStore when USE_PG_LANGGRAPH is false", async () => {
            vi.stubEnv("USE_PG_LANGGRAPH", "false");
            vi.stubEnv("DYNAMODB_CHECKPOINT_TABLE", "test-checkpoints");
            vi.stubEnv("DYNAMODB_WRITES_TABLE", "test-writes");
            vi.stubEnv("DYNAMODB_CHAT_HISTORY_TABLE", "test-chat");
            vi.stubEnv("DYNAMODB_MEMORY_TABLE", "test-memory");

            const { getMemoryStore } = await import("./persistence");
            const store = await getMemoryStore();
            expect((store as { type: string }).type).toBe("DynamoDBStore");
        });
    });

    describe("PostgreSQL backend (USE_PG_LANGGRAPH=true)", () => {
        it("getCheckpointer() returns PostgresSaver when USE_PG_LANGGRAPH=true", async () => {
            vi.stubEnv("USE_PG_LANGGRAPH", "true");
            vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/test");

            const { getCheckpointer } = await import("./persistence");
            const checkpointer = await getCheckpointer();
            expect((checkpointer as { type: string }).type).toBe("PostgresSaver");
        });

        it("getChatHistory() returns PostgresChatHistory when USE_PG_LANGGRAPH=true", async () => {
            vi.stubEnv("USE_PG_LANGGRAPH", "true");
            vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/test");

            const { getChatHistory } = await import("./persistence");
            const history = await getChatHistory();
            // PostgresChatHistory has addMessages and getMessages methods
            expect(typeof (history as { addMessages: unknown }).addMessages).toBe("function");
            expect(typeof (history as { getMessages: unknown }).getMessages).toBe("function");
        });

        it("getMemoryStore() returns PostgresMemoryStore when USE_PG_LANGGRAPH=true", async () => {
            vi.stubEnv("USE_PG_LANGGRAPH", "true");
            vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/test");

            const { getMemoryStore } = await import("./persistence");
            const store = await getMemoryStore();
            // PostgresMemoryStore has batch method
            expect(typeof (store as { batch: unknown }).batch).toBe("function");
        });
    });

    describe("singleton pattern", () => {
        it("calling getCheckpointer() twice returns the same instance", async () => {
            vi.stubEnv("USE_PG_LANGGRAPH", "false");
            vi.stubEnv("DYNAMODB_CHECKPOINT_TABLE", "test-checkpoints");
            vi.stubEnv("DYNAMODB_WRITES_TABLE", "test-writes");
            vi.stubEnv("DYNAMODB_CHAT_HISTORY_TABLE", "test-chat");
            vi.stubEnv("DYNAMODB_MEMORY_TABLE", "test-memory");

            const { getCheckpointer } = await import("./persistence");
            const first = await getCheckpointer();
            const second = await getCheckpointer();
            expect(first).toBe(second);
        });
    });

    describe("public API exports", () => {
        it("exports all 5 required functions", async () => {
            const mod = await import("./persistence");
            expect(typeof mod.getCheckpointer).toBe("function");
            expect(typeof mod.getMemoryStore).toBe("function");
            expect(typeof mod.getChatHistory).toBe("function");
            expect(typeof mod.saveMemory).toBe("function");
            expect(typeof mod.searchMemory).toBe("function");
        });
    });
});
