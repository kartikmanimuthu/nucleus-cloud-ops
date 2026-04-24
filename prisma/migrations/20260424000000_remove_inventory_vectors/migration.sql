-- Remove inventory vector embedding columns and table
-- Vector search was replaced by full-text search (tsvector/plainto_tsquery)

ALTER TABLE "inventory_resources" DROP COLUMN IF EXISTS "embedding";
ALTER TABLE "inventory_resources" DROP COLUMN IF EXISTS "content_hash";
DROP TABLE IF EXISTS "inventory_vector_keys";
