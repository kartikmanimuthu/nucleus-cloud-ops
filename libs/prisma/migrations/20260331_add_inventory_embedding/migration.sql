-- Add embedding and contentHash columns to inventory_resources
ALTER TABLE "inventory_resources" ADD COLUMN "embedding" vector(1024);
ALTER TABLE "inventory_resources" ADD COLUMN "contentHash" TEXT;

-- Create ivfflat index for cosine distance similarity search
CREATE INDEX "idx_inventory_resources_embedding" ON "inventory_resources" USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
