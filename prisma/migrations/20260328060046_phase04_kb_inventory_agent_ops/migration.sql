-- CreateTable
CREATE TABLE "knowledge_bases" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "vectorCount" INTEGER NOT NULL DEFAULT 0,
    "dataSourceCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "knowledge_bases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_sources" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "knowledgeBaseId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "config" JSONB NOT NULL DEFAULT '{}',
    "vectorCount" INTEGER NOT NULL DEFAULT 0,
    "vectorKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "data_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_resources" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "name" TEXT,
    "status" TEXT,
    "tags" JSONB NOT NULL DEFAULT '{}',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_ops_runs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "taskDescription" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'plan',
    "accountId" TEXT,
    "accountName" TEXT,
    "selectedSkill" TEXT,
    "autoApprove" BOOLEAN NOT NULL DEFAULT false,
    "model" TEXT,
    "threadId" TEXT NOT NULL,
    "mcpServerIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "trigger" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "clarification" JSONB,
    "approvalRequest" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_ops_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_ops_events" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "node" TEXT NOT NULL,
    "content" TEXT,
    "toolName" TEXT,
    "toolArgs" JSONB,
    "toolOutput" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_ops_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_tasks" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "cronExpression" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "taskStatus" TEXT NOT NULL DEFAULT 'active',
    "mode" TEXT NOT NULL DEFAULT 'plan',
    "autoApprove" BOOLEAN NOT NULL DEFAULT false,
    "model" TEXT,
    "accountId" TEXT,
    "accountName" TEXT,
    "mcpServerIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notification" JSONB NOT NULL DEFAULT '{}',
    "lastRunId" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "lastRunStatus" TEXT,
    "nextRunAt" TIMESTAMP(3),
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "scheduled_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_task_locks" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "scheduledAt" TEXT NOT NULL,
    "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheduled_task_locks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "knowledge_bases_tenantId_idx" ON "knowledge_bases"("tenantId");

-- CreateIndex
CREATE INDEX "data_sources_tenantId_idx" ON "data_sources"("tenantId");

-- CreateIndex
CREATE INDEX "data_sources_knowledgeBaseId_idx" ON "data_sources"("knowledgeBaseId");

-- CreateIndex
CREATE INDEX "inventory_resources_tenantId_resourceType_idx" ON "inventory_resources"("tenantId", "resourceType");

-- CreateIndex
CREATE INDEX "inventory_resources_tenantId_accountId_idx" ON "inventory_resources"("tenantId", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_resources_tenantId_accountId_resourceType_resourc_key" ON "inventory_resources"("tenantId", "accountId", "resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "agent_ops_runs_tenantId_idx" ON "agent_ops_runs"("tenantId");

-- CreateIndex
CREATE INDEX "agent_ops_runs_tenantId_status_idx" ON "agent_ops_runs"("tenantId", "status");

-- CreateIndex
CREATE INDEX "agent_ops_runs_tenantId_source_idx" ON "agent_ops_runs"("tenantId", "source");

-- CreateIndex
CREATE INDEX "agent_ops_runs_source_createdAt_idx" ON "agent_ops_runs"("source", "createdAt");

-- CreateIndex
CREATE INDEX "agent_ops_runs_expiresAt_idx" ON "agent_ops_runs"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "agent_ops_runs_tenantId_runId_key" ON "agent_ops_runs"("tenantId", "runId");

-- CreateIndex
CREATE INDEX "agent_ops_events_tenantId_runId_idx" ON "agent_ops_events"("tenantId", "runId");

-- CreateIndex
CREATE INDEX "agent_ops_events_runId_createdAt_idx" ON "agent_ops_events"("runId", "createdAt");

-- CreateIndex
CREATE INDEX "agent_ops_events_expiresAt_idx" ON "agent_ops_events"("expiresAt");

-- CreateIndex
CREATE INDEX "scheduled_tasks_tenantId_idx" ON "scheduled_tasks"("tenantId");

-- CreateIndex
CREATE INDEX "scheduled_tasks_tenantId_taskStatus_idx" ON "scheduled_tasks"("tenantId", "taskStatus");

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_tasks_tenantId_taskId_key" ON "scheduled_tasks"("tenantId", "taskId");

-- CreateIndex
CREATE INDEX "scheduled_task_locks_expiresAt_idx" ON "scheduled_task_locks"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_task_locks_taskId_scheduledAt_key" ON "scheduled_task_locks"("taskId", "scheduledAt");

-- AddForeignKey
ALTER TABLE "data_sources" ADD CONSTRAINT "data_sources_knowledgeBaseId_fkey" FOREIGN KEY ("knowledgeBaseId") REFERENCES "knowledge_bases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_ops_events" ADD CONSTRAINT "agent_ops_events_tenantId_runId_fkey" FOREIGN KEY ("tenantId", "runId") REFERENCES "agent_ops_runs"("tenantId", "runId") ON DELETE CASCADE ON UPDATE CASCADE;

-- CHECK constraints (Prisma 5 does not emit these natively)
ALTER TABLE "knowledge_bases" ADD CONSTRAINT "knowledge_bases_status_check" CHECK ("status" IN ('active', 'inactive'));
ALTER TABLE "data_sources" ADD CONSTRAINT "data_sources_source_type_check" CHECK ("sourceType" IN ('file-upload', 's3-bucket', 'confluence', 'bitbucket'));
ALTER TABLE "data_sources" ADD CONSTRAINT "data_sources_status_check" CHECK ("status" IN ('pending', 'syncing', 'synced', 'error'));
ALTER TABLE "agent_ops_runs" ADD CONSTRAINT "agent_ops_runs_source_check" CHECK ("source" IN ('slack', 'jira', 'api', 'scheduled'));
ALTER TABLE "agent_ops_runs" ADD CONSTRAINT "agent_ops_runs_status_check" CHECK ("status" IN ('queued', 'in_progress', 'awaiting_input', 'awaiting_approval', 'completed', 'failed', 'cancelled'));
ALTER TABLE "agent_ops_runs" ADD CONSTRAINT "agent_ops_runs_mode_check" CHECK ("mode" IN ('plan', 'fast'));
ALTER TABLE "agent_ops_events" ADD CONSTRAINT "agent_ops_events_event_type_check" CHECK ("eventType" IN ('planning', 'execution', 'tool_call', 'tool_result', 'reflection', 'revision', 'final', 'error'));
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_status_check" CHECK ("taskStatus" IN ('active', 'paused', 'deleted'));
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_mode_check" CHECK ("mode" IN ('plan', 'fast'));
