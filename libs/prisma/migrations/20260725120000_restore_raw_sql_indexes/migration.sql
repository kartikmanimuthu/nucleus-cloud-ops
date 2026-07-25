-- Restore the three raw-SQL indexes that 20260717101822_add_telegram_bot_link dropped.
--
-- Those indexes are created by earlier hand-written migrations and are invisible to
-- schema.prisma (pgvector `Unsupported("vector")` / tsvector columns have no Prisma
-- index syntax), so `prisma migrate dev` read them as drift and emitted DROP INDEX
-- alongside the intended telegram_bot_links table. Dropping them is silent: queries
-- still return correct results, they just fall back to sequential scans — memory
-- recall, KB semantic search and inventory full-text search all degrade under load.
--
-- The upstream migration is left byte-identical (editing an already-applied migration
-- would fail `prisma migrate deploy` on a checksum mismatch); this forward migration
-- is idempotent, so it is safe whether or not the drops ever reached a given database.

-- pgvector HNSW index for cosine similarity on agent memories
-- (originally: 20260701235449_agent_memory_foundation)
CREATE INDEX IF NOT EXISTS "agent_memories_embedding_hnsw"
  ON "agent_memories" USING hnsw ("embedding" vector_cosine_ops);

-- GIN index backing inventory full-text search
-- (originally: 20260405_add_inventory_search_vector, recreated by 20260408)
CREATE INDEX IF NOT EXISTS idx_inventory_search_vector
  ON "inventory_resources" USING GIN ("searchVector");

-- IVFFlat vector index for KB document-chunk similarity search
-- (originally: 20260407194124_add_kb_document_chunks)
CREATE INDEX IF NOT EXISTS idx_kb_document_chunks_embedding
  ON kb_document_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
