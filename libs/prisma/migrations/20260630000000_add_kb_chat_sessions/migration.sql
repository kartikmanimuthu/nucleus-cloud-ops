-- CreateTable
CREATE TABLE "kb_chat_sessions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'New Chat',
    "knowledgeBaseId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kb_chat_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kb_chat_messages" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kb_chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "kb_chat_sessions_sessionId_key" ON "kb_chat_sessions"("sessionId");

-- CreateIndex
CREATE INDEX "kb_chat_sessions_tenantId_updatedAt_idx" ON "kb_chat_sessions"("tenantId", "updatedAt");

-- CreateIndex
CREATE INDEX "kb_chat_messages_tenantId_sessionId_createdAt_idx" ON "kb_chat_messages"("tenantId", "sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "kb_chat_messages_expiresAt_idx" ON "kb_chat_messages"("expiresAt");
