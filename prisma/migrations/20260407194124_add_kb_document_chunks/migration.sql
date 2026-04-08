-- CreateTable
CREATE TABLE "kb_document_chunks" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "knowledgeBaseId" TEXT NOT NULL,
    "dataSourceId" TEXT NOT NULL,
    "vectorKey" TEXT NOT NULL,
    "documentName" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "totalChunks" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "textContent" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "embedding" vector(1024) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kb_document_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "kb_document_chunks_vectorKey_key" ON "kb_document_chunks"("vectorKey");

-- CreateIndex
CREATE INDEX "kb_document_chunks_tenantId_knowledgeBaseId_idx" ON "kb_document_chunks"("tenantId", "knowledgeBaseId");

-- CreateIndex
CREATE INDEX "kb_document_chunks_tenantId_dataSourceId_idx" ON "kb_document_chunks"("tenantId", "dataSourceId");

-- CreateIndex
CREATE INDEX "kb_document_chunks_vectorKey_idx" ON "kb_document_chunks"("vectorKey");

-- IVFFlat vector index for cosine similarity search
CREATE INDEX idx_kb_document_chunks_embedding ON kb_document_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
