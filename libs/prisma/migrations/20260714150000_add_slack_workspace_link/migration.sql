-- CreateTable
CREATE TABLE "slack_workspace_links" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "botUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "slack_workspace_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "slack_workspace_links_teamId_key" ON "slack_workspace_links"("teamId");

-- CreateIndex
CREATE INDEX "slack_workspace_links_tenantId_idx" ON "slack_workspace_links"("tenantId");

-- AddForeignKey
ALTER TABLE "slack_workspace_links" ADD CONSTRAINT "slack_workspace_links_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
