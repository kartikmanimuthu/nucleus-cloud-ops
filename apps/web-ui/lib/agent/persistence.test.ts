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

const prismaMock = {
    chatMessage: {
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    agentMemory: {
        findFirst: vi.fn().mockResolvedValue(null),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        create: vi.fn().mockResolvedValue({}),
        findMany: vi.fn().mockResolvedValue([]),
    },
    $executeRaw: vi.fn().mockResolvedValue(0),
    $queryRaw: vi.fn().mockResolvedValue([]),
};

vi.mock("@/lib/db/pg-config", () => ({
    getPrismaClient: vi.fn(() => prismaMock),
}));

vi.mock("./embeddings-factory", () => ({
    getTenantEmbeddings: vi.fn(),
}));

vi.mock("./memory/memory-service", () => ({
    getMemoryService: vi.fn(),
}));

import { getTenantEmbeddings } from "./embeddings-factory";
import { getMemoryService } from "./memory/memory-service";

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

    describe("PostgresChatHistory", () => {
        beforeEach(() => {
            prismaMock.chatMessage.createMany.mockClear();
            prismaMock.chatMessage.findMany.mockClear();
            prismaMock.chatMessage.deleteMany.mockClear();
        });

        it("addMessages() persists each message scoped to the tenant + session with a 30-day expiry", async () => {
            const { getChatHistory } = await import("./persistence");
            const history = await getChatHistory();

            await history.addMessages("tenant-1", "user-1", "thread-1", [
                { role: "user", content: "hi" },
                { role: "assistant", content: "hello", metadata: { foo: "bar" } },
            ]);

            expect(prismaMock.chatMessage.createMany).toHaveBeenCalledWith({
                data: [
                    expect.objectContaining({ tenantId: "tenant-1", sessionId: "thread-1", role: "user", content: "hi", metadata: undefined }),
                    expect.objectContaining({ tenantId: "tenant-1", sessionId: "thread-1", role: "assistant", content: "hello", metadata: { foo: "bar" } }),
                ],
                skipDuplicates: true,
            });
            const expiresAt = prismaMock.chatMessage.createMany.mock.calls[0][0].data[0].expiresAt as Date;
            expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000);
        });

        it("getMessages() reads back tenant/session-scoped rows in ascending order, normalizing null metadata to undefined", async () => {
            prismaMock.chatMessage.findMany.mockResolvedValueOnce([
                { role: "user", content: "hi", metadata: null, createdAt: new Date("2026-01-01") },
            ]);
            const { getChatHistory } = await import("./persistence");
            const history = await getChatHistory();

            const messages = await history.getMessages("tenant-1", "user-1", "thread-1");

            expect(prismaMock.chatMessage.findMany).toHaveBeenCalledWith({
                where: { tenantId: "tenant-1", sessionId: "thread-1" },
                orderBy: { createdAt: "asc" },
            });
            expect(messages).toEqual([{ role: "user", content: "hi", metadata: undefined, createdAt: new Date("2026-01-01") }]);
        });

        it("clearMessages() deletes all rows scoped to the tenant + session", async () => {
            const { getChatHistory } = await import("./persistence");
            const history = await getChatHistory();
            await history.clearMessages("tenant-1", "user-1", "thread-1");
            expect(prismaMock.chatMessage.deleteMany).toHaveBeenCalledWith({ where: { tenantId: "tenant-1", sessionId: "thread-1" } });
        });
    });

    describe("PostgresMemoryStore.batch — put operations", () => {
        beforeEach(() => {
            prismaMock.agentMemory.findFirst.mockReset().mockResolvedValue(null);
            prismaMock.agentMemory.updateMany.mockClear();
            prismaMock.agentMemory.create.mockReset().mockResolvedValue({});
            prismaMock.$executeRaw.mockClear();
            vi.mocked(getTenantEmbeddings).mockReset().mockResolvedValue({
                embedQuery: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
            } as any);
        });

        const putOp = (overrides: Record<string, unknown> = {}) => ({
            namespace: ["memories"], key: "k1", value: { fact: "x" },
            ...overrides,
        });

        it("writes via a single upsert-style $executeRaw when embedding succeeds", async () => {
            const { getMemoryStore } = await import("./persistence");
            const store = await getMemoryStore();

            const results = await store.batch([putOp()], { configurable: { tenant_id: "tenant-1", user_id: "user-1" } });

            expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(1);
            expect(prismaMock.agentMemory.create).not.toHaveBeenCalled();
            expect(results).toEqual([null]);
        });

        it("falls back to find-live-then-create when embedding fails and no live row exists", async () => {
            vi.mocked(getTenantEmbeddings).mockResolvedValue({ embedQuery: vi.fn().mockRejectedValue(new Error("no provider")) } as any);
            const { getMemoryStore } = await import("./persistence");
            const store = await getMemoryStore();

            await store.batch([putOp()], { configurable: { tenant_id: "tenant-1", user_id: "user-1" } });

            expect(prismaMock.$executeRaw).not.toHaveBeenCalled();
            expect(prismaMock.agentMemory.create).toHaveBeenCalledWith({
                data: expect.objectContaining({ tenantId: "tenant-1", userId: "user-1", namespace: "memories", key: "k1" }),
            });
        });

        it("falls back to update-in-place when embedding fails and a live row already exists", async () => {
            vi.mocked(getTenantEmbeddings).mockResolvedValue({ embedQuery: vi.fn().mockRejectedValue(new Error("no provider")) } as any);
            prismaMock.agentMemory.findFirst.mockResolvedValue({ id: "row-1" });
            const { getMemoryStore } = await import("./persistence");
            const store = await getMemoryStore();

            await store.batch([putOp()], { configurable: { tenant_id: "tenant-1" } });

            expect(prismaMock.agentMemory.updateMany).toHaveBeenCalledWith({
                where: { id: "row-1", tenantId: "tenant-1" },
                data: expect.objectContaining({ value: { fact: "x" } }),
            });
            expect(prismaMock.agentMemory.create).not.toHaveBeenCalled();
        });

        it("retries as an update of the concurrent winner on a P2002 unique-violation from create", async () => {
            vi.mocked(getTenantEmbeddings).mockResolvedValue({ embedQuery: vi.fn().mockRejectedValue(new Error("no provider")) } as any);
            prismaMock.agentMemory.create.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }));
            prismaMock.agentMemory.findFirst
                .mockResolvedValueOnce(null) // first check: no live row, attempt create
                .mockResolvedValueOnce({ id: "winner-1" }); // race lost — the winner now exists
            const { getMemoryStore } = await import("./persistence");
            const store = await getMemoryStore();

            await store.batch([putOp()], { configurable: { tenant_id: "tenant-1" } });

            expect(prismaMock.agentMemory.updateMany).toHaveBeenCalledWith({
                where: { id: "winner-1", tenantId: "tenant-1" },
                data: expect.objectContaining({ value: { fact: "x" } }),
            });
        });

        it("rethrows a P2002 error if the concurrent winner cannot be found either", async () => {
            vi.mocked(getTenantEmbeddings).mockResolvedValue({ embedQuery: vi.fn().mockRejectedValue(new Error("no provider")) } as any);
            const p2002 = Object.assign(new Error("unique"), { code: "P2002" });
            prismaMock.agentMemory.create.mockRejectedValueOnce(p2002);
            prismaMock.agentMemory.findFirst.mockResolvedValue(null);
            const { getMemoryStore } = await import("./persistence");
            const store = await getMemoryStore();

            await expect(store.batch([putOp()], { configurable: { tenant_id: "tenant-1" } })).rejects.toThrow("unique");
        });

        it("rethrows immediately on a non-P2002 create error", async () => {
            vi.mocked(getTenantEmbeddings).mockResolvedValue({ embedQuery: vi.fn().mockRejectedValue(new Error("no provider")) } as any);
            prismaMock.agentMemory.create.mockRejectedValueOnce(new Error("db down"));
            const { getMemoryStore } = await import("./persistence");
            const store = await getMemoryStore();

            await expect(store.batch([putOp()], { configurable: { tenant_id: "tenant-1" } })).rejects.toThrow("db down");
        });

        it("caches the embeddings provider per tenant across multiple ops in the same batch", async () => {
            const { getMemoryStore } = await import("./persistence");
            const store = await getMemoryStore();

            await store.batch(
                [putOp({ key: "k1" }), putOp({ key: "k2" })],
                { configurable: { tenant_id: "tenant-1" } },
            );

            expect(getTenantEmbeddings).toHaveBeenCalledTimes(1);
        });

        it("does not cache a rejected embeddings promise — a later op retries it", async () => {
            vi.mocked(getTenantEmbeddings)
                .mockRejectedValueOnce(new Error("provider misconfigured"))
                .mockResolvedValueOnce({ embedQuery: vi.fn().mockResolvedValue([0.1]) } as any);
            const { getMemoryStore } = await import("./persistence");
            const store = await getMemoryStore();

            await store.batch([putOp({ key: "k1" })], { configurable: { tenant_id: "tenant-1" } });
            await store.batch([putOp({ key: "k2" })], { configurable: { tenant_id: "tenant-1" } });

            expect(getTenantEmbeddings).toHaveBeenCalledTimes(2);
        });

        it("defaults tenantId/userId to 'default' when no configurable is provided", async () => {
            const { getMemoryStore } = await import("./persistence");
            const store = await getMemoryStore();
            vi.mocked(getTenantEmbeddings).mockResolvedValue({ embedQuery: vi.fn().mockRejectedValue(new Error("x")) } as any);

            await store.batch([putOp()]);

            expect(prismaMock.agentMemory.create).toHaveBeenCalledWith({
                data: expect.objectContaining({ tenantId: "default", userId: "default" }),
            });
        });

        it("pushes a null result for an op that matches neither the put nor search shape", async () => {
            const { getMemoryStore } = await import("./persistence");
            const store = await getMemoryStore();
            const results = await store.batch([{ somethingElse: true }]);
            expect(results).toEqual([null]);
        });
    });

    describe("PostgresMemoryStore.batch — search operations", () => {
        beforeEach(() => {
            prismaMock.$queryRaw.mockReset().mockResolvedValue([{ key: "k1", value: { a: 1 }, namespace: "memories" }]);
            prismaMock.agentMemory.findMany.mockReset().mockResolvedValue([{ key: "k1", value: { a: 1 }, namespace: "memories" }]);
            vi.mocked(getTenantEmbeddings).mockReset().mockResolvedValue({ embedQuery: vi.fn().mockResolvedValue([0.1]) } as any);
        });

        const searchOp = (overrides: Record<string, unknown> = {}) => ({
            namespacePrefix: ["memories"], query: "find me", limit: 3,
            ...overrides,
        });

        it("runs a vector search scoped to a namespace prefix when embedding succeeds", async () => {
            const { getMemoryStore } = await import("./persistence");
            const store = await getMemoryStore();

            const results = await store.batch([searchOp()], { configurable: { tenant_id: "tenant-1" } });

            expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
            expect(results).toEqual([[{ key: "k1", value: { a: 1 }, namespace: "memories" }]]);
        });

        it("runs an unscoped vector search when no namespace prefix is given", async () => {
            const { getMemoryStore } = await import("./persistence");
            const store = await getMemoryStore();
            await store.batch([searchOp({ namespacePrefix: [] })], { configurable: { tenant_id: "tenant-1" } });
            expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
        });

        it("falls back to recency-ordered findMany scoped by namespace prefix when embedding fails", async () => {
            vi.mocked(getTenantEmbeddings).mockResolvedValue({ embedQuery: vi.fn().mockRejectedValue(new Error("no provider")) } as any);
            const { getMemoryStore } = await import("./persistence");
            const store = await getMemoryStore();

            await store.batch([searchOp()], { configurable: { tenant_id: "tenant-1" } });

            expect(prismaMock.agentMemory.findMany).toHaveBeenCalledWith({
                where: { tenantId: "tenant-1", namespace: { startsWith: "memories" } },
                take: 3,
                orderBy: { createdAt: "desc" },
            });
        });

        it("falls back to unscoped recency-ordered findMany when embedding fails and there is no namespace prefix", async () => {
            vi.mocked(getTenantEmbeddings).mockResolvedValue({ embedQuery: vi.fn().mockRejectedValue(new Error("no provider")) } as any);
            const { getMemoryStore } = await import("./persistence");
            const store = await getMemoryStore();

            await store.batch([searchOp({ namespacePrefix: [] })], { configurable: { tenant_id: "tenant-1" } });

            expect(prismaMock.agentMemory.findMany).toHaveBeenCalledWith({
                where: { tenantId: "tenant-1" },
                take: 3,
                orderBy: { createdAt: "desc" },
            });
        });
    });

    describe("initPersistence failure", () => {
        it("clears the in-flight promise on failure so a later call retries instead of reusing the rejection", async () => {
            const { PostgresSaver } = await import("@langchain/langgraph-checkpoint-postgres");
            vi.mocked(PostgresSaver.fromConnString).mockReturnValueOnce({
                type: "PostgresSaver", setup: vi.fn().mockRejectedValue(new Error("connection refused")),
            } as any);

            const { getCheckpointer } = await import("./persistence");
            await expect(getCheckpointer()).rejects.toThrow("connection refused");

            // Retried with a healthy setup this time.
            vi.mocked(PostgresSaver.fromConnString).mockReturnValueOnce({
                type: "PostgresSaver", setup: vi.fn().mockResolvedValue(undefined),
            } as any);
            const checkpointer = await getCheckpointer();
            expect((checkpointer as any).type).toBe("PostgresSaver");
        });
    });

    describe("saveMemory / searchMemory", () => {
        it("saveMemory() delegates to MemoryService.remember with kind SEMANTIC", async () => {
            const remember = vi.fn().mockResolvedValue(undefined);
            vi.mocked(getMemoryService).mockReturnValue({ remember, recall: vi.fn() } as any);

            const { saveMemory } = await import("./persistence");
            await saveMemory("tenant-1", "user-1", ["ns"], "k1", { a: 1 });

            expect(remember).toHaveBeenCalledWith({ tenantId: "tenant-1", userId: "user-1", kind: "SEMANTIC", namespace: ["ns"], key: "k1", value: { a: 1 } });
        });

        it("searchMemory() delegates to MemoryService.recall and maps hits to {key, value, namespace}", async () => {
            const recall = vi.fn().mockResolvedValue([{ key: "k1", value: { a: 1 }, namespace: ["ns"], extraneous: true }]);
            vi.mocked(getMemoryService).mockReturnValue({ remember: vi.fn(), recall } as any);

            const { searchMemory } = await import("./persistence");
            const results = await searchMemory("tenant-1", "user-1", ["ns"], "query text", 7);

            expect(recall).toHaveBeenCalledWith({ tenantId: "tenant-1", userId: "user-1", query: "query text", namespacePrefix: ["ns"], limit: 7 });
            expect(results).toEqual([{ key: "k1", value: { a: 1 }, namespace: ["ns"] }]);
        });
    });
});
