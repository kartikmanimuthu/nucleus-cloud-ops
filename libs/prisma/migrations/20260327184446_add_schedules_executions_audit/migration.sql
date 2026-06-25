-- CreateTable
CREATE TABLE "schedules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "starttime" TEXT NOT NULL,
    "endtime" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "days" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "resources" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL DEFAULT 'system',
    "updatedBy" TEXT NOT NULL DEFAULT 'system',

    CONSTRAINT "schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_executions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "executionTime" TIMESTAMP(3) NOT NULL,
    "resourcesStarted" INTEGER NOT NULL DEFAULT 0,
    "resourcesStopped" INTEGER NOT NULL DEFAULT 0,
    "resourcesFailed" INTEGER NOT NULL DEFAULT 0,
    "duration" INTEGER,
    "errorMessage" TEXT,
    "details" JSONB,
    "scheduleMetadata" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schedule_executions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "schedule_executions_status_check" CHECK (status IN ('pending', 'running', 'success', 'failed', 'partial'))
);

-- CreateTable
CREATE TABLE "targeted_resources" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "resourceArn" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "name" TEXT,
    "clusterArn" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "targeted_resources_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "targeted_resources_resource_type_check" CHECK ("resourceType" IN ('ec2', 'ecs', 'rds', 'asg', 'docdb'))
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "logId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "eventType" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "user" TEXT NOT NULL DEFAULT 'system',
    "userType" TEXT NOT NULL DEFAULT 'system',
    "resource" TEXT,
    "resourceType" TEXT,
    "resourceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'info',
    "severity" TEXT NOT NULL DEFAULT 'info',
    "details" TEXT,
    "metadata" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "sessionId" TEXT,
    "correlationId" TEXT,
    "executionId" TEXT,
    "region" TEXT,
    "accountId" TEXT,
    "duration" INTEGER,
    "errorCode" TEXT,
    "source" TEXT NOT NULL DEFAULT 'system',
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "audit_logs_status_check" CHECK (status IN ('success', 'error', 'warning', 'info', 'pending')),
    CONSTRAINT "audit_logs_severity_check" CHECK (severity IN ('low', 'medium', 'high', 'critical', 'info'))
);

-- CreateIndex
CREATE INDEX "schedules_tenantId_idx" ON "schedules"("tenantId");

-- CreateIndex
CREATE INDEX "schedules_tenantId_active_idx" ON "schedules"("tenantId", "active");

-- CreateIndex
CREATE INDEX "schedules_tenantId_accountId_idx" ON "schedules"("tenantId", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "schedules_tenantId_scheduleId_key" ON "schedules"("tenantId", "scheduleId");

-- CreateIndex
CREATE INDEX "schedule_executions_tenantId_idx" ON "schedule_executions"("tenantId");

-- CreateIndex
CREATE INDEX "schedule_executions_tenantId_scheduleId_idx" ON "schedule_executions"("tenantId", "scheduleId");

-- CreateIndex
CREATE INDEX "schedule_executions_tenantId_status_idx" ON "schedule_executions"("tenantId", "status");

-- CreateIndex
CREATE INDEX "schedule_executions_expiresAt_idx" ON "schedule_executions"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_executions_tenantId_executionId_key" ON "schedule_executions"("tenantId", "executionId");

-- CreateIndex
CREATE INDEX "targeted_resources_tenantId_scheduleId_idx" ON "targeted_resources"("tenantId", "scheduleId");

-- CreateIndex
CREATE UNIQUE INDEX "targeted_resources_tenantId_scheduleId_resourceArn_key" ON "targeted_resources"("tenantId", "scheduleId", "resourceArn");

-- CreateIndex
CREATE INDEX "audit_logs_tenantId_idx" ON "audit_logs"("tenantId");

-- CreateIndex
CREATE INDEX "audit_logs_tenantId_eventType_idx" ON "audit_logs"("tenantId", "eventType");

-- CreateIndex
CREATE INDEX "audit_logs_tenantId_user_idx" ON "audit_logs"("tenantId", "user");

-- CreateIndex
CREATE INDEX "audit_logs_tenantId_timestamp_idx" ON "audit_logs"("tenantId", "timestamp");

-- CreateIndex
CREATE INDEX "audit_logs_expiresAt_idx" ON "audit_logs"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "audit_logs_tenantId_logId_key" ON "audit_logs"("tenantId", "logId");
