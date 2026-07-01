-- CreateEnum
CREATE TYPE "MemoryKind" AS ENUM ('SEMANTIC', 'EPISODIC', 'PROCEDURAL');

-- AlterTable
ALTER TABLE "agent_memories" ADD COLUMN     "accessCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "kind" "MemoryKind" NOT NULL DEFAULT 'SEMANTIC',
ADD COLUMN     "lastAccessedAt" TIMESTAMP(3),
ADD COLUMN     "sourceThreadId" TEXT,
ADD COLUMN     "supersededAt" TIMESTAMP(3),
ADD COLUMN     "supersededById" TEXT;

-- CreateTable
CREATE TABLE "agent_working_memory" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "runningSummary" TEXT NOT NULL,
    "scratchpad" JSONB NOT NULL,
    "tokenCount" INTEGER NOT NULL DEFAULT 0,
    "turnCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_working_memory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_working_memory_expiresAt_idx" ON "agent_working_memory"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "agent_working_memory_tenantId_threadId_key" ON "agent_working_memory"("tenantId", "threadId");

-- CreateIndex
CREATE INDEX "agent_memories_tenantId_kind_idx" ON "agent_memories"("tenantId", "kind");

-- pgvector HNSW index for cosine similarity (matches the <=> queries in persistence.ts)
CREATE INDEX IF NOT EXISTS "agent_memories_embedding_hnsw"
  ON "agent_memories" USING hnsw ("embedding" vector_cosine_ops);
