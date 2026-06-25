/**
 * RIGHT_SIZING_CONFIG (RS-004).
 *
 * Single tunable source of thresholds for the recommendation engine. Keeping all knobs
 * here (rather than scattered across rule modules) makes the rules deterministic and
 * adjustable from pilot feedback without code changes across modules.
 *
 * Values are defaults from TRD §5; override per-environment as needed.
 */
export interface RightSizingThresholds {
    /** CPU p95 below this (%) → candidate for downsizing. */
    cpuOverProvisionedPct: number;
    /** CPU p95 above this (%) → candidate for upsizing. */
    cpuUnderProvisionedPct: number;
    /** Memory p95 below this (%) reinforces over-provisioned (when memory available). */
    memOverProvisionedPct: number;
    /** Memory p95 above this (%) → under-provisioned. */
    memUnderProvisionedPct: number;
    /** CPU p95 below this (%) AND low network → idle. */
    cpuIdlePct: number;
}

export const RIGHT_SIZING_CONFIG = {
    /** Lookback window for metric collection (days). */
    lookbackDays: 14,
    /** CloudWatch period in seconds for GetMetricData (1h). */
    metricPeriodSeconds: 3600,
    /** Minimum days of coverage for a high-confidence recommendation. */
    minCoverageDaysHighConfidence: 7,
    /** Minimum datapoint density [0,1] for high confidence. */
    minDatapointDensityHighConfidence: 0.8,
    /** Capacity headroom multiplier over observed p95 when picking a target size. */
    headroomMultiplier: 1.4,
    /** Idle EC2 network threshold (bytes p95 over the window, in+out). */
    idleNetworkBytesP95: 5 * 1024 * 1024,

    ec2: {
        cpuOverProvisionedPct: 40,
        cpuUnderProvisionedPct: 85,
        memOverProvisionedPct: 50,
        memUnderProvisionedPct: 90,
        cpuIdlePct: 3,
    } satisfies RightSizingThresholds,

    rds: {
        cpuOverProvisionedPct: 40,
        cpuUnderProvisionedPct: 85,
        memOverProvisionedPct: 50,
        memUnderProvisionedPct: 90,
        cpuIdlePct: 5,
    } satisfies RightSizingThresholds,

    ebs: {
        /** gp3 is cheaper than gp2 at baseline — always evaluated. */
        evaluateGp2ToGp3: true,
        /** Provisioned IOPS over used p95 by this factor → recommend lower IOPS. */
        iopsOverProvisionFactor: 2.0,
    },

    asg: {
        cpuOverProvisionedPct: 40,
        cpuUnderProvisionedPct: 85,
    },
} as const;

export type RightSizingConfig = typeof RIGHT_SIZING_CONFIG;
