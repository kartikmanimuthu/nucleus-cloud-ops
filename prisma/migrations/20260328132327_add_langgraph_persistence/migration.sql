-- Enable pgvector extension for vector similarity search (LANG-03)
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable: agent_memories (LANG-03)
CREATE TABLE "agent_memories" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "embedding" vector(1024),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_memories_pkey" PRIMARY KEY ("id")
);

-- CreateTable: chat_messages (LANG-02)
CREATE TABLE "chat_messages" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_memories_tenantId_namespace_key_key" ON "agent_memories"("tenantId", "namespace", "key");

-- CreateIndex
CREATE INDEX "agent_memories_tenantId_userId_idx" ON "agent_memories"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "agent_memories_expiresAt_idx" ON "agent_memories"("expiresAt");

-- CreateIndex
CREATE INDEX "chat_messages_tenantId_sessionId_createdAt_idx" ON "chat_messages"("tenantId", "sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "chat_messages_expiresAt_idx" ON "chat_messages"("expiresAt");
