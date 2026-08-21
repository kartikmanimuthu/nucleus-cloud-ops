-- Scaling Audit: CloudWatch-backed capacity enrichment (SA-003).
--
-- WHY: the STX ops team's own quarterly compliance workbook closes a gap this
-- module already knew about (see the "?" in formatCapacityChange()) by reading
-- the DesiredTaskCount metric time series directly instead of trusting the
-- scaling API's event payload. Rows sourced from CloudTrail structurally never
-- carry a "before" value (requestParameters only has the after value — see
-- cloudtrail-client.ts toRawActivity()), and most ECS aws_api rows don't either
-- (Application Auto Scaling's Cause text never states a range). CloudWatch's
-- own metric history is the only place that value still exists.
--
-- Forward-only by design: scaling_audit_daily_seals hashes desiredBefore/
-- desiredAfter into its digest (daily-seal.ts computeSeal()). Backfilling
-- desiredBefore on already-sealed historical rows would silently invalidate
-- every seal computed after that day. These columns are populated only for
-- newly-ingested events going forward; existing rows keep whatever they were
-- captured with.
--
-- Three additive, nullable columns — no existing row needs a value, no CHECK on
-- the new Float columns, and desiredBeforeSource's CHECK only ever narrows what
-- NULL already allowed.
--
-- Hand-authored per CLAUDE.md — `prisma migrate dev` would attempt destructive
-- drift-correction against the raw-SQL CHECK constraints and triggers already
-- present on this table (see 20260805140000_scaling_audit_block_truncate).

ALTER TABLE "scaling_events" ADD COLUMN "desiredBeforeSource" TEXT;
ALTER TABLE "scaling_events" ADD COLUMN "peakCpuBeforeScale" DOUBLE PRECISION;
ALTER TABLE "scaling_events" ADD COLUMN "peakMemoryBeforeScale" DOUBLE PRECISION;

ALTER TABLE "scaling_events" ADD CONSTRAINT "scaling_events_desired_before_source_check"
    CHECK ("desiredBeforeSource" IS NULL OR "desiredBeforeSource" IN ('activity', 'cloudwatch'));
