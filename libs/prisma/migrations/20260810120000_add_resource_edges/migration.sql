CREATE TABLE "resource_edges" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "fromType" TEXT NOT NULL,
    "fromId" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "toType" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "toAccountId" TEXT,
    "jobRunId" TEXT,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "resource_edges_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "resource_edges_tenant_account_edge_key"
    ON "resource_edges"("tenantId", "accountId", "fromType", "fromId", "relation", "toType", "toId");

CREATE INDEX "resource_edges_forward_idx"
    ON "resource_edges"("tenantId", "fromType", "fromId", "isCurrent");

CREATE INDEX "resource_edges_reverse_idx"
    ON "resource_edges"("tenantId", "toType", "toId", "isCurrent");

CREATE INDEX "resource_edges_account_idx"
    ON "resource_edges"("tenantId", "accountId", "isCurrent");
