-- CreateTable
CREATE TABLE "pricing_catalog" (
    "id" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "serviceCode" TEXT NOT NULL,
    "resourceClass" TEXT NOT NULL,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "pricePerHour" DOUBLE PRECISION,
    "pricePerGiBMonth" DOUBLE PRECISION,
    "pricePerIopsMonth" DOUBLE PRECISION,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "refreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pricing_catalog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pricing_catalog_serviceCode_region_idx" ON "pricing_catalog"("serviceCode", "region");

-- CreateIndex
CREATE UNIQUE INDEX "pricing_catalog_region_serviceCode_resourceClass_key" ON "pricing_catalog"("region", "serviceCode", "resourceClass");

