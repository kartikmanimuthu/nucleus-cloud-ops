// workers/src/jobs/capacity-planning/config.ts
//
// Tunables for the Capacity Planning job (SA-004). Structurally mirrors
// scaling-audit/config.ts.
export const CAPACITY_PLANNING_CONFIG = {
    /** Daily fan-out, off the :00 mark (like every other job's cron here). */
    cron: '27 2 * * *',

    /** CloudWatch keeps 1-hour datapoints for 455 days — a resource with no
     *  prior sample backfills this far on its first poll, so day-one behavior
     *  already has a multi-quarter history instead of starting empty. */
    backfillDays: 450,

    /** Re-fetch this many hours before the last written bucket, in case the
     *  most recent hour was still incomplete (mid-hour) at the previous poll. */
    watermarkOverlapHours: 2,

    /** Breach threshold used by the default "Breach Instances" view — matches
     *  the STX reference workbook's ">70%" framing. Callers may override per query. */
    defaultBreachThresholdPercent: 70,
} as const;

export type CapacityPlanningConfig = typeof CAPACITY_PLANNING_CONFIG;
