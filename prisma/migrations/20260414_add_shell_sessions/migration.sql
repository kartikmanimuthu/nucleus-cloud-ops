-- Migration: add_shell_sessions
-- Adds the shell_sessions table for tracking Cloud Shell sessions per tenant/user.

CREATE TABLE "shell_sessions" (
    "id"            TEXT NOT NULL,
    "tenantId"      TEXT NOT NULL,
    "userId"        TEXT NOT NULL,
    "accountId"     TEXT,
    "accountName"   TEXT,
    "region"        TEXT NOT NULL DEFAULT 'us-east-1',
    "status"        TEXT NOT NULL DEFAULT 'active',
    "approvalMode"  TEXT NOT NULL DEFAULT 'manual',
    "startedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActiveAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "terminatedAt"  TIMESTAMP(3),

    CONSTRAINT "shell_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "shell_sessions_tenantId_userId_status_idx" ON "shell_sessions"("tenantId", "userId", "status");
CREATE INDEX "shell_sessions_tenantId_status_idx" ON "shell_sessions"("tenantId", "status");
