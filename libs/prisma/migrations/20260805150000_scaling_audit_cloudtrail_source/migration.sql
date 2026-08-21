-- Add 'cloudtrail' as a third capture source for Scale Sentinel (SA-002).
--
-- WHY: a direct ecs:UpdateService call is invisible to
-- application-autoscaling:DescribeScalingActivities, which only returns
-- activities Application Auto Scaling itself initiated. Verified live on
-- 2026-08-05: the test service was created with desiredCount=1 at 10:34 and the
-- oldest AAS activity is the scheduled action at 10:37 — the creation produced
-- nothing. So manual ECS scaling is currently absent from the compliance record
-- entirely, and manual ASG scaling is recorded but with no individual principal
-- ("a user request"). CloudTrail is the only source for either.
--
-- Hand-authored, per CLAUDE.md: `prisma migrate dev` would attempt destructive
-- drift-correction against the raw-SQL objects (CHECK constraints, triggers,
-- REVOKEs) that Prisma does not model.

-- ── 1. Per-source watermarks ────────────────────────────────────────────────
-- BLOCKING CONSTRAINT this migration exists to fix: the unique key was
-- (tenantId, accountId, region, scope) with no source column, so a CloudTrail
-- poll of scope='ecs' would collide with the activity-API mark for that same
-- scope. Each source paginates a different API and holds an independent
-- position; sharing one row would make them overwrite each other and silently
-- skip windows.
--
-- DEFAULT 'aws_api' backfills every existing row with its correct meaning, so
-- this is additive — no watermark is reset and no re-poll is triggered.
ALTER TABLE "scaling_audit_watermarks"
    ADD COLUMN "source" TEXT NOT NULL DEFAULT 'aws_api';

DROP INDEX "scaling_audit_watermarks_tenantId_accountId_region_scope_key";

-- Name is exactly what Prisma derives for @@unique([tenantId, accountId, region,
-- scope, source]) after its 63-char truncation — confirmed via
-- `prisma migrate diff`. Getting this wrong leaves a permanent RenameIndex in
-- every future drift check, which in a repo of hand-authored migrations is how
-- destructive drift-correction gets invited in.
CREATE UNIQUE INDEX "scaling_audit_watermarks_tenantId_accountId_region_scope_so_key"
    ON "scaling_audit_watermarks"("tenantId", "accountId", region, scope, "source");

-- 'platform' is deliberately NOT allowed here: those rows are written
-- synchronously by the schedulers at mutation time, never polled, so they have
-- no watermark to advance.
ALTER TABLE "scaling_audit_watermarks" ADD CONSTRAINT "scaling_audit_watermarks_source_check"
    CHECK ("source" IN ('aws_api', 'cloudtrail'));

-- ── 2. Widen the source enums ───────────────────────────────────────────────
-- scaling_events keeps its existing unique key (tenantId, source, activityId):
-- CloudTrail's eventID slots straight in, giving idempotent re-capture for free
-- and keeping a CloudTrail observation distinct from the activity-API
-- observation of the same underlying change (which is intended — they are two
-- independent pieces of evidence, deliberately not merged).
ALTER TABLE "scaling_events" DROP CONSTRAINT "scaling_events_source_check";
ALTER TABLE "scaling_events" ADD CONSTRAINT "scaling_events_source_check"
    CHECK ("source" IN ('aws_api', 'platform', 'cloudtrail'));

ALTER TABLE "scaling_audit_coverage" DROP CONSTRAINT "scaling_audit_coverage_source_check";
ALTER TABLE "scaling_audit_coverage" ADD CONSTRAINT "scaling_audit_coverage_source_check"
    CHECK ("source" IN ('aws_api', 'platform', 'cloudtrail'));

-- NOT changed, deliberately:
--   * "scope" CHECK ('asg','ecs') — CloudTrail rows map onto the same two scopes
--     (UpdateService → ecs, SetDesiredCapacity/UpdateAutoScalingGroup → asg).
--   * "actorType" CHECK — already permits 'user', which is what a CloudTrail
--     row carries once userIdentity proves a human principal.
--   * "scalingType" CHECK — CloudTrail rows reuse 'manual' rather than adding a
--     value. Here 'manual' is evidence-based, not the guess the classifier is
--     forbidden to make: userIdentity names the principal. Reusing it keeps
--     "show me all manual changes" consistent across both scopes;
--     source='cloudtrail' distinguishes it when that matters.
