-- CreateTable: inventory_vector_keys (KB-01)
CREATE TABLE "inventory_vector_keys" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "vectorKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_vector_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "inventory_vector_keys_accountId_key" ON "inventory_vector_keys"("accountId");
