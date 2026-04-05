-- Add tsvector fulltext search column to inventory_resources
-- Uses weighted vectors: A=name, B=resourceType+resourceId, C=region+status+tags, D=metadata

-- 1. Add the search_vector column
ALTER TABLE "inventory_resources" ADD COLUMN "search_vector" tsvector;

-- 2. Create trigger function to auto-populate search_vector on INSERT/UPDATE
CREATE OR REPLACE FUNCTION inventory_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW."resourceType", '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW."resourceId", '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.region, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(NEW.status, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(NEW.tags::text, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(NEW.metadata::text, '')), 'D');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

-- 3. Create trigger on inventory_resources
CREATE TRIGGER trg_inventory_search_vector
  BEFORE INSERT OR UPDATE ON "inventory_resources"
  FOR EACH ROW
  EXECUTE FUNCTION inventory_search_vector_update();

-- 4. GIN index for fast fulltext queries
CREATE INDEX idx_inventory_search_vector ON "inventory_resources" USING GIN ("search_vector");

-- 5. Backfill existing rows
UPDATE "inventory_resources" SET
  "search_vector" =
    setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce("resourceType", '')), 'B') ||
    setweight(to_tsvector('english', coalesce("resourceId", '')), 'B') ||
    setweight(to_tsvector('english', coalesce(region, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(status, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(tags::text, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(metadata::text, '')), 'D');
