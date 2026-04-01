-- Add slug column to tenants table (nullable — existing tenants don't have slugs)
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "slug" TEXT;

-- Unique constraint — no two tenants share a slug
CREATE UNIQUE INDEX IF NOT EXISTS "tenants_slug_key" ON "tenants"("slug");
