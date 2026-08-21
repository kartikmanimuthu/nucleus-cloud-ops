-- Safety net for the three indexes schema.prisma cannot describe.
--
-- pgvector (hnsw/ivfflat) and tsvector GIN indexes have no Prisma schema syntax, so
-- `prisma migrate dev` reads them as drift and silently writes DROP INDEX into whatever
-- migration a developer happens to be generating. That already happened once:
-- 20260717101822_add_telegram_bot_link dropped all three, and
-- 20260725120000_restore_raw_sql_indexes had to put them back. Dropping them raises no
-- error and loses no data — memory recall, KB search and inventory search just fall back
-- to full scans.
--
-- Run after `prisma migrate deploy` everywhere (docker-entrypoint.sh, predev). Idempotent:
-- a no-op catalog lookup when the indexes are present, which is the normal case.
--
-- Keep every statement CREATE INDEX IF NOT EXISTS. `prisma db execute` sends the file as a
-- single command, so CONCURRENTLY would fail here — it cannot run inside a transaction.

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
