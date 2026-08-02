-- AgentSubagentRun — one row per dispatch_agent sub-agent so a collapsed card can be
-- expanded after a page reload. Secrets are redacted at the persistence boundary
-- (apps/web-ui/lib/agent/subagent-redact.ts) before any transcript reaches this table.
--
-- AUDIT NOTE: `prisma migrate diff` emitted three unrelated statements ahead of this
-- table and they were deleted by hand, as the repo's history requires:
--     DROP INDEX "agent_memories_embedding_hnsw";
--     DROP INDEX "idx_inventory_search_vector";
--     DROP INDEX "idx_kb_document_chunks_embedding";
-- Those indexes are created by raw SQL (HNSW / GIN) and are invisible to the Prisma
-- datamodel, so every generated migration treats them as drift. Dropping them would
-- silently destroy vector search and inventory full-text search — the same damage
-- 20260725120000_restore_raw_sql_indexes exists to repair. Do not re-add them.

-- CreateTable
CREATE TABLE "agent_subagent_runs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "subagentId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "toolCount" INTEGER NOT NULL DEFAULT 0,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "summary" TEXT,
    "transcript" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_subagent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_subagent_runs_tenantId_threadId_createdAt_idx" ON "agent_subagent_runs"("tenantId", "threadId", "createdAt");

-- CreateIndex
CREATE INDEX "agent_subagent_runs_expiresAt_idx" ON "agent_subagent_runs"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "agent_subagent_runs_tenantId_threadId_subagentId_key" ON "agent_subagent_runs"("tenantId", "threadId", "subagentId");
