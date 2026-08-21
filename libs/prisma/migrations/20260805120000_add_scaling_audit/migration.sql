-- ═══════════════════════════════════════════════════════════════════════════════
-- Scaling Audit (SA-001) — ECS + ASG scaling event capture for SEBI compliance.
--
-- ⚠️  HAND-AUTHORED — DO NOT REGENERATE THIS FILE WITH `prisma migrate dev`.
--
-- Same two reasons as 20260725201753_add_spot_guard:
--   1. Prisma 5 does not emit CHECK constraints — every string enum here relies on
--      one below. The declared source of truth for each value set is the union
--      types in apps/web-ui/lib/db/repositories/scaling-audit/interface.ts; keep
--      them in sync.
--   2. `prisma migrate dev` diffs against pre-existing raw-SQL-managed objects
--      (vector/fulltext indexes, the spot_guard/right_sizing hand-authored DDL)
--      and proposes destroying them. This migration is additive-only: no DROP,
--      no RENAME, no ALTER COLUMN, no type change to any pre-existing table.
--
-- This migration also adds real DB-level immutability (REVOKE + trigger) that
-- `prisma migrate dev` has no syntax to express at all.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── CreateTable: scaling_events ───────────────────────────────────────────────
CREATE TABLE "scaling_events" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "region" TEXT NOT NULL,

    "scope" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,

    "resourceId" TEXT NOT NULL,
    "asgName" TEXT,
    "clusterName" TEXT,
    "serviceName" TEXT,
    "scalableDimension" TEXT,
    "inventoryMatched" BOOLEAN NOT NULL DEFAULT false,

    "scalingType" TEXT NOT NULL,
    "policyName" TEXT,
    "scheduledActionName" TEXT,
    "alarmName" TEXT,
    "notScaledCode" TEXT,
    "derivationVersion" INTEGER NOT NULL DEFAULT 1,
    "causeFingerprint" TEXT NOT NULL,

    "cause" TEXT NOT NULL,
    "description" TEXT,
    "statusCode" TEXT,
    "statusMessage" TEXT,
    "notScaledReasons" JSONB,
    "rawPayload" JSONB NOT NULL DEFAULT '{}',

    "desiredBefore" INTEGER,
    "desiredAfter" INTEGER,
    "minBefore" INTEGER,
    "maxBefore" INTEGER,
    "minAfter" INTEGER,
    "maxAfter" INTEGER,
    "capacityDelta" INTEGER,

    "actor" TEXT NOT NULL DEFAULT 'system',
    "actorType" TEXT NOT NULL DEFAULT 'system',
    "initiatedBy" TEXT,
    "correlationId" TEXT,

    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "endedAt" TIMESTAMPTZ(3),
    "durationSeconds" DOUBLE PRECISION,
    "reportDateIst" DATE NOT NULL,

    "capturedByRunId" TEXT NOT NULL,
    "capturedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scaling_events_pkey" PRIMARY KEY ("id")
);

-- ── CreateTable: scaling_audit_coverage ───────────────────────────────────────
CREATE TABLE "scaling_audit_coverage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "source" TEXT NOT NULL,

    "windowStart" TIMESTAMPTZ(3) NOT NULL,
    "windowEnd" TIMESTAMPTZ(3) NOT NULL,

    "status" TEXT NOT NULL,
    "reason" TEXT,

    "activityCount" INTEGER NOT NULL DEFAULT 0,
    "apiCallCount" INTEGER NOT NULL DEFAULT 0,
    "pagesFetched" INTEGER NOT NULL DEFAULT 0,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "oldestActivitySeenAt" TIMESTAMPTZ(3),
    "newestActivitySeenAt" TIMESTAMPTZ(3),

    "runId" TEXT NOT NULL,
    "attemptedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scaling_audit_coverage_pkey" PRIMARY KEY ("id")
);

-- ── CreateTable: scaling_audit_runs ───────────────────────────────────────────
CREATE TABLE "scaling_audit_runs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "trigger" TEXT NOT NULL DEFAULT 'schedule',

    "accountsScanned" INTEGER NOT NULL DEFAULT 0,
    "scopesPolled" INTEGER NOT NULL DEFAULT 0,
    "eventsSeen" INTEGER NOT NULL DEFAULT 0,
    "eventsCaptured" INTEGER NOT NULL DEFAULT 0,
    "policySnapshots" INTEGER NOT NULL DEFAULT 0,
    "gapsDetected" INTEGER NOT NULL DEFAULT 0,
    "apiCallCount" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB NOT NULL DEFAULT '[]',

    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "scaling_audit_runs_pkey" PRIMARY KEY ("id")
);

-- ── CreateTable: scaling_audit_watermarks ─────────────────────────────────────
CREATE TABLE "scaling_audit_watermarks" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "scope" TEXT NOT NULL,

    "lastActivityAt" TIMESTAMPTZ(3),
    "lastActivityId" TEXT,
    "lastPolledAt" TIMESTAMPTZ(3),
    "lastRunId" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,

    "gapDetected" BOOLEAN NOT NULL DEFAULT false,
    "gapFromAt" TIMESTAMPTZ(3),
    "gapToAt" TIMESTAMPTZ(3),
    "gapReason" TEXT,

    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scaling_audit_watermarks_pkey" PRIMARY KEY ("id")
);

-- ── CreateTable: scaling_policy_snapshots ─────────────────────────────────────
CREATE TABLE "scaling_policy_snapshots" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "scope" TEXT NOT NULL,

    "resourceId" TEXT NOT NULL,
    "configHash" TEXT NOT NULL,

    "policies" JSONB NOT NULL DEFAULT '[]',
    "scheduledActions" JSONB NOT NULL DEFAULT '[]',
    "minCapacity" INTEGER,
    "maxCapacity" INTEGER,

    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scaling_policy_snapshots_pkey" PRIMARY KEY ("id")
);

-- ── CreateTable: scaling_audit_daily_seals ────────────────────────────────────
CREATE TABLE "scaling_audit_daily_seals" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "day" DATE NOT NULL,

    "rowCount" INTEGER NOT NULL,
    "rowsDigest" TEXT NOT NULL,
    "prevSeal" TEXT,
    "seal" TEXT NOT NULL,

    "sealedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scaling_audit_daily_seals_pkey" PRIMARY KEY ("id")
);

-- ── CreateIndex ────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "scaling_events_tenantId_source_activityId_key" ON "scaling_events"("tenantId", "source", "activityId");
CREATE INDEX "scaling_events_tenantId_startedAt_idx" ON "scaling_events"("tenantId", "startedAt");
CREATE INDEX "scaling_events_tenantId_reportDateIst_idx" ON "scaling_events"("tenantId", "reportDateIst");
CREATE INDEX "scaling_events_tenantId_scope_scalingType_startedAt_idx" ON "scaling_events"("tenantId", "scope", "scalingType", "startedAt");
CREATE INDEX "scaling_events_tenantId_accountId_region_startedAt_idx" ON "scaling_events"("tenantId", "accountId", "region", "startedAt");
CREATE INDEX "scaling_events_tenantId_resourceId_startedAt_idx" ON "scaling_events"("tenantId", "resourceId", "startedAt");
CREATE INDEX "scaling_events_tenantId_causeFingerprint_idx" ON "scaling_events"("tenantId", "causeFingerprint");

CREATE INDEX "scaling_audit_coverage_tenantId_accountId_region_scope_sour_idx" ON "scaling_audit_coverage"("tenantId", "accountId", "region", "scope", "source", "windowStart");
CREATE INDEX "scaling_audit_coverage_tenantId_status_idx" ON "scaling_audit_coverage"("tenantId", "status");
CREATE INDEX "scaling_audit_coverage_tenantId_runId_idx" ON "scaling_audit_coverage"("tenantId", "runId");

CREATE INDEX "scaling_audit_runs_tenantId_startedAt_idx" ON "scaling_audit_runs"("tenantId", "startedAt");

CREATE UNIQUE INDEX "scaling_audit_watermarks_tenantId_accountId_region_scope_key" ON "scaling_audit_watermarks"("tenantId", "accountId", "region", "scope");
CREATE INDEX "scaling_audit_watermarks_tenantId_gapDetected_idx" ON "scaling_audit_watermarks"("tenantId", "gapDetected");

CREATE UNIQUE INDEX "scaling_policy_snapshots_tenantId_accountId_region_scope_r_key" ON "scaling_policy_snapshots"("tenantId", "accountId", "region", "scope", "resourceId", "configHash");
CREATE INDEX "scaling_policy_snapshots_tenantId_accountId_region_resourc_idx" ON "scaling_policy_snapshots"("tenantId", "accountId", "region", "resourceId", "lastSeenAt");

CREATE UNIQUE INDEX "scaling_audit_daily_seals_tenantId_day_key" ON "scaling_audit_daily_seals"("tenantId", "day");

-- ── CHECK constraints for string enums (Prisma 5 cannot emit these) ──────────
ALTER TABLE "scaling_events" ADD CONSTRAINT "scaling_events_scope_check"
    CHECK ("scope" IN ('asg', 'ecs'));

ALTER TABLE "scaling_events" ADD CONSTRAINT "scaling_events_source_check"
    CHECK ("source" IN ('aws_api', 'platform'));

ALTER TABLE "scaling_events" ADD CONSTRAINT "scaling_events_scaling_type_check"
    CHECK ("scalingType" IN (
        'scheduled', 'target_tracking', 'step', 'simple', 'predictive', 'manual',
        'health_check_replacement', 'capacity_rebalance', 'instance_refresh',
        'az_rebalance', 'max_instance_lifetime', 'not_scaled', 'unparsed'
    ));

ALTER TABLE "scaling_events" ADD CONSTRAINT "scaling_events_actor_type_check"
    CHECK ("actorType" IN ('system', 'user', 'unattributed_out_of_band'));

ALTER TABLE "scaling_audit_coverage" ADD CONSTRAINT "scaling_audit_coverage_scope_check"
    CHECK ("scope" IN ('asg', 'ecs'));

ALTER TABLE "scaling_audit_coverage" ADD CONSTRAINT "scaling_audit_coverage_source_check"
    CHECK ("source" IN ('aws_api', 'platform'));

ALTER TABLE "scaling_audit_coverage" ADD CONSTRAINT "scaling_audit_coverage_status_check"
    CHECK ("status" IN ('covered', 'partial', 'failed', 'skipped'));

ALTER TABLE "scaling_audit_runs" ADD CONSTRAINT "scaling_audit_runs_status_check"
    CHECK ("status" IN ('queued', 'running', 'completed', 'partial', 'failed'));

ALTER TABLE "scaling_audit_runs" ADD CONSTRAINT "scaling_audit_runs_trigger_check"
    CHECK ("trigger" IN ('schedule', 'manual', 'backfill'));

ALTER TABLE "scaling_audit_watermarks" ADD CONSTRAINT "scaling_audit_watermarks_scope_check"
    CHECK ("scope" IN ('asg', 'ecs'));

ALTER TABLE "scaling_policy_snapshots" ADD CONSTRAINT "scaling_policy_snapshots_scope_check"
    CHECK ("scope" IN ('asg', 'ecs'));

-- ── Immutability: convention alone ("no update/delete method in the repository
-- interface") is not evidence. Enforce it in the database for the two tables
-- that ARE the compliance record: scaling_events (the events) and
-- scaling_audit_daily_seals (the tamper-evidence chain over those events).
--
-- REVOKE targets CURRENT_USER, i.e. whichever role runs this migration. This repo
-- uses a single DATABASE_URL for both migrations and the running app (see
-- .env.example), so in every real environment that is the same role the app
-- connects as. NOTE: a local dev Postgres superuser bypasses REVOKE entirely —
-- superusers are exempt from all privilege checks — so the trigger below, which
-- fires unconditionally for every role including superusers, is the actual
-- enforcement mechanism, not the REVOKE. Keep both: REVOKE is real hardening in
-- any environment using a non-superuser app role (production), the trigger is
-- belt-and-braces against a future over-broad GRANT.
REVOKE UPDATE, DELETE ON "scaling_events" FROM CURRENT_USER;
REVOKE UPDATE, DELETE ON "scaling_audit_daily_seals" FROM CURRENT_USER;

CREATE OR REPLACE FUNCTION scaling_audit_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'scaling audit records are append-only: % on "%" is not permitted (SEBI compliance evidence — see libs/prisma/schema.prisma)', TG_OP, TG_TABLE_NAME;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_scaling_events_immutable
  BEFORE UPDATE OR DELETE ON "scaling_events"
  FOR EACH ROW
  EXECUTE FUNCTION scaling_audit_reject_mutation();

CREATE TRIGGER trg_scaling_audit_daily_seals_immutable
  BEFORE UPDATE OR DELETE ON "scaling_audit_daily_seals"
  FOR EACH ROW
  EXECUTE FUNCTION scaling_audit_reject_mutation();
