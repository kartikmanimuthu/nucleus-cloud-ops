// workers/src/jobs/scaling-audit/config.ts
//
// Tunables for the Scaling Audit job (SA-001). Structurally mirrors
// right-sizing/config.ts.
export const SCALING_AUDIT_CONFIG = {
    /** SEBI is India-based — report-day grouping (reportDateIst) uses this zone.
     *  Storage itself always stays UTC (@db.Timestamptz(3)). */
    reportTimezone: 'Asia/Kolkata',

    /** Cron — 18:50 UTC = 00:20 IST, so "yesterday IST" is fully closed. */
    cron: '50 18 * * *',

    /** Re-fetch this many minutes before the last captured activity, so an
     *  activity that was in-flight at the last poll gets re-read to completion. */
    watermarkOverlapMinutes: 5,

    /** AWS's own retention for scaling-activity history is ~6 weeks. Flag a gap
     *  well before that ceiling (not at it) so there is time to react. */
    awsRetentionDays: 38,

    /** Hard cap per (account, region, scope) per run — bounds worst-case runtime
     *  on the very first (backfill) run against a busy, never-polled account. */
    maxPagesPerScope: 50,

    /** ECS/Application Auto Scaling: also capture activities that were attempted
     *  but suppressed (e.g. AlreadyAtMaxCapacity) — often the highest-value audit
     *  signal there is. */
    includeNotScaledActivities: true,

    /** Network Pulse (DX/VPN bandwidth + availability): how far back CloudWatch
     *  is queried for hourly buckets on each scan. CloudWatch's own retention for
     *  these metrics is well beyond this (15 months at 1-hour resolution), so
     *  this is a scan-cost/relevance choice, not an AWS ceiling. */
    networkLinkLookbackDays: 45,
} as const;

export type ScalingAuditConfig = typeof SCALING_AUDIT_CONFIG;
