// workers/src/jobs/right-sizing/config.ts
//
// Tunable thresholds for the recommendation engine (RS-004/RS-010).
// Structurally mirrors web-ui/lib/right-sizing/config.ts (separate npm package).
export const RIGHT_SIZING_CONFIG = {
    lookbackDays: 14,
    metricPeriodSeconds: 3600,
    minCoverageDaysHighConfidence: 7,
    minDatapointDensityHighConfidence: 0.8,
    headroomMultiplier: 1.4,
    idleNetworkBytesP95: 5 * 1024 * 1024,
    /** Confidence below this forces riskLevel = 'high'. */
    lowConfidenceRiskThreshold: 0.4,

    ec2: {
        cpuOverProvisionedPct: 40,
        cpuUnderProvisionedPct: 85,
        memOverProvisionedPct: 50,
        memUnderProvisionedPct: 90,
        cpuIdlePct: 3,
    },
    rds: {
        cpuOverProvisionedPct: 40,
        cpuUnderProvisionedPct: 85,
        memOverProvisionedPct: 50,
        memUnderProvisionedPct: 90,
        cpuIdlePct: 5,
    },
    ebs: {
        evaluateGp2ToGp3: true,
        iopsOverProvisionFactor: 2.0,
    },
    asg: {
        cpuOverProvisionedPct: 40,
        cpuUnderProvisionedPct: 85,
    },
} as const;

export type RightSizingConfig = typeof RIGHT_SIZING_CONFIG;

export const HOURS_PER_MONTH = 730;
