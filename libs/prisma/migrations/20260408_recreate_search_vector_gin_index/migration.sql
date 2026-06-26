-- Recreate GIN index on "searchVector" (dropped by 20260406183139 and never recreated)
CREATE INDEX IF NOT EXISTS idx_inventory_search_vector ON "inventory_resources" USING GIN ("searchVector");
