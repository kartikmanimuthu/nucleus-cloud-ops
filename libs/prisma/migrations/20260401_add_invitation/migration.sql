CREATE TABLE "invitations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "invitedBy" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "invitations_tenantId_email_status_key" ON "invitations"("tenantId", "email", "status");
CREATE INDEX "invitations_tenantId_idx" ON "invitations"("tenantId");
CREATE INDEX "invitations_tenantId_status_idx" ON "invitations"("tenantId", "status");
CREATE INDEX "invitations_email_idx" ON "invitations"("email");

ALTER TABLE "invitations" ADD CONSTRAINT "invitations_status_check" CHECK ("status" IN ('pending', 'accepted', 'revoked', 'expired'));
