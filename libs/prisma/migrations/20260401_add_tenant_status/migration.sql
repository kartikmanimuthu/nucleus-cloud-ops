-- Add status column to tenants table
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'active';

-- Enforce valid values
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_status_check" CHECK ("status" IN ('active', 'suspended'));

-- Index for suspension queries
CREATE INDEX IF NOT EXISTS "tenants_status_idx" ON "tenants"("status");
