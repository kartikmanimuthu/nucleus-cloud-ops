-- CreateTable
CREATE TABLE "right_sizing_recommendations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "name" TEXT,
    "finding" TEXT NOT NULL,
    "currentConfig" JSONB NOT NULL DEFAULT '{}',
    "recommendedConfig" JSONB,
    "metricsSummary" JSONB NOT NULL DEFAULT '{}',
    "lookbackDays" INTEGER NOT NULL DEFAULT 14,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "currentMonthlyCost" DOUBLE PRECISION,
    "recommendedMonthlyCost" DOUBLE PRECISION,
    "estimatedMonthlySavings" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "riskLevel" TEXT NOT NULL DEFAULT 'medium',
    "rationale" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT 'cloudwatch',
    "status" TEXT NOT NULL DEFAULT 'open',
    "snoozeUntil" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "generatedByRunId" TEXT,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "right_sizing_recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "right_sizing_runs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "trigger" TEXT NOT NULL DEFAULT 'schedule',
    "lookbackDays" INTEGER NOT NULL DEFAULT 14,
    "accountsScanned" INTEGER NOT NULL DEFAULT 0,
    "resourcesAnalyzed" INTEGER NOT NULL DEFAULT 0,
    "recommendationsGenerated" INTEGER NOT NULL DEFAULT 0,
    "totalEstimatedSavings" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "right_sizing_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "right_sizing_recommendations_tenantId_finding_idx" ON "right_sizing_recommendations"("tenantId", "finding");

-- CreateIndex
CREATE INDEX "right_sizing_recommendations_tenantId_status_idx" ON "right_sizing_recommendations"("tenantId", "status");

-- CreateIndex
CREATE INDEX "right_sizing_recommendations_tenantId_estimatedMonthlySavin_idx" ON "right_sizing_recommendations"("tenantId", "estimatedMonthlySavings");

-- CreateIndex
CREATE UNIQUE INDEX "right_sizing_recommendations_tenantId_accountId_resourceTyp_key" ON "right_sizing_recommendations"("tenantId", "accountId", "resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "right_sizing_runs_tenantId_startedAt_idx" ON "right_sizing_runs"("tenantId", "startedAt");

