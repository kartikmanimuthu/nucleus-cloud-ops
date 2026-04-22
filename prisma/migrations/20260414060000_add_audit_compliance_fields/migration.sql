-- Add compliance fields to audit_logs table (SOC 2 / NIST AU-3)
ALTER TABLE "audit_logs" ADD COLUMN "changeSet" JSONB;
ALTER TABLE "audit_logs" ADD COLUMN "requestId" TEXT;
ALTER TABLE "audit_logs" ADD COLUMN "apiRoute" TEXT;
ALTER TABLE "audit_logs" ADD COLUMN "httpMethod" TEXT;
ALTER TABLE "audit_logs" ADD COLUMN "dataClassification" TEXT;
ALTER TABLE "audit_logs" ADD COLUMN "retentionDays" INTEGER NOT NULL DEFAULT 90;

-- Add composite indexes for common dashboard queries
CREATE INDEX "audit_logs_tenantId_source_timestamp_idx" ON "audit_logs"("tenantId", "source", "timestamp");
CREATE INDEX "audit_logs_tenantId_resourceType_resourceId_idx" ON "audit_logs"("tenantId", "resourceType", "resourceId");
