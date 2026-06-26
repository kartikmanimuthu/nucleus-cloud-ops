/**
 * persistence.test.ts
 *
 * Unit tests for persistence.ts — PostgreSQL-only backend.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

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
        vi.stubEnv("DATABASE_URL", "postgresql://localhost:5432/test");
    });

    afterEach(() => {
        clearPersistenceSingleton();
        vi.unstubAllEnvs();
    });

    describe("PostgreSQL backend", () => {
        it("getCheckpointer() returns PostgresSaver", async () => {
            const { getCheckpointer } = await import("./persistence");
            const checkpointer = await getCheckpointer();
            expect((checkpointer as { type: string }).type).toBe("PostgresSaver");
        });

        it("getChatHistory() returns PostgresChatHistory", async () => {
            const { getChatHistory } = await import("./persistence");
            const history = await getChatHistory();
            expect(typeof (history as { addMessages: unknown }).addMessages).toBe("function");
            expect(typeof (history as { getMessages: unknown }).getMessages).toBe("function");
            expect(typeof (history as { clearMessages: unknown }).clearMessages).toBe("function");
        });

        it("getMemoryStore() returns PostgresMemoryStore", async () => {
            const { getMemoryStore } = await import("./persistence");
            const store = await getMemoryStore();
            expect(typeof (store as { batch: unknown }).batch).toBe("function");
        });
    });

    describe("singleton pattern", () => {
        it("calling getCheckpointer() twice returns the same instance", async () => {
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
