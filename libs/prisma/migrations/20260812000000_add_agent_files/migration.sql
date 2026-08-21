-- CreateTable
CREATE TABLE "agent_files" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_files_tenantId_namespace_idx" ON "agent_files"("tenantId", "namespace");

-- CreateIndex
CREATE UNIQUE INDEX "agent_files_tenantId_namespace_key_key" ON "agent_files"("tenantId", "namespace", "key");
