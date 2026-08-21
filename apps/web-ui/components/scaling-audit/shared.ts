import { formatDate, formatDateTime } from "@/lib/date-utils";

/**
 * SEBI is India-based — every timestamp in Scale Sentinel is shown in IST,
 * never the viewer's browser-local zone (date-utils.ts: "NEVER use
 * toLocaleString() in components"). A browser-local render is a compliance
 * bug here, not a cosmetic one: it can put an event on the wrong calendar day
 * for a viewer outside IST.
 *
 * No "IST" suffix on the value itself — callers label the column/field
 * "(IST)" once instead (matches the reference compliance workbook's
 * "Date (IST)" column convention), so a dense table doesn't repeat the zone
 * on every row.
 */
export function formatIstDateTime(input: string | Date | number | null | undefined): string {
    if (input == null) return "—";
    return formatDateTime(input, "shortDateTime", "Asia/Kolkata");
}

export function formatIstDate(input: string | Date | number | null | undefined): string {
    if (input == null) return "—";
    return formatDate(input, "shortDate", "Asia/Kolkata");
}

export const SCALING_TYPE_LABELS: Record<string, string> = {
    scheduled: 'Scheduled',
    target_tracking: 'Target Tracking',
    step: 'Step Scaling',
    simple: 'Simple Scaling',
    predictive: 'Predictive',
    manual: 'Manual',
    // Mechanism, not intent: a direct API call outside any scaling policy. The
    // caller may be a person or a pipeline — the actor ARN is what tells you which.
    direct_api: 'Direct API Call',
    // AWS-initiated, not a human/pipeline call — e.g. RDS's own storage
    // autoscaling growing a volume when free space drops below the threshold.
    storage_autoscaling: 'Storage Autoscaling',
    health_check_replacement: 'Health Check Replacement',
    capacity_rebalance: 'Capacity Rebalance',
    instance_refresh: 'Instance Refresh',
    az_rebalance: 'AZ Rebalance',
    max_instance_lifetime: 'Max Instance Lifetime',
    not_scaled: 'Not Scaled (Suppressed)',
    unparsed: 'Unparsed',
};

export const SCOPE_LABELS: Record<string, string> = {
    asg: 'ASG',
    ecs: 'ECS Service',
    rds: 'RDS Instance',
    msk: 'MSK Cluster',
    elasticache: 'ElastiCache Cluster',
    docdb: 'DocDB Instance',
};

export const SOURCE_LABELS: Record<string, string> = {
    aws_api: 'AWS API',
    platform: 'Platform',
    // Out-of-band changes the activity APIs cannot see, plus the human principal
    // behind a manual ASG change.
    cloudtrail: 'CloudTrail',
};

export function scalingTypeLabel(type: string): string {
    return SCALING_TYPE_LABELS[type] ?? type;
}

/**
 * Render a capacity change for display.
 *
 * CloudTrail records the REQUESTED desired count and nothing about the prior
 * value — `responseElements.service` returns the post-update object, and its
 * runningCount is a mid-deployment snapshot, not the previous desired capacity.
 * So for source='cloudtrail' rows desiredBefore is structurally unavailable.
 *
 * Rendering that as "? → 1" reads like data we lost or failed to parse. "→ 1"
 * reads as what it is: capacity was set to 1, and the prior value is not
 * something this source can tell us. Inferring one from the preceding event
 * would be a guess, and a wrong guess in a compliance record is worse than an
 * acknowledged blank.
 */
export function formatCapacityChange(desiredBefore?: number | null, desiredAfter?: number | null): string {
    if (desiredBefore == null && desiredAfter == null) return "—";
    if (desiredBefore == null) return `→ ${desiredAfter}`;
    if (desiredAfter == null) return `${desiredBefore} → ?`;
    return `${desiredBefore} → ${desiredAfter}`;
}

/**
 * Explains where the "before" value came from — or why it's missing — on hover.
 *
 * desiredBeforeSource distinguishes two very different cases that used to look
 * identical: 'activity' means the AWS Cause/Description text named it directly;
 * 'cloudwatch' means it was recovered from the DesiredTaskCount metric time
 * series after the source's own payload came up empty (true for every
 * CloudTrail row and most ECS aws_api rows). A still-missing value means
 * CloudWatch's own retention window had already lost the datapoint too.
 */
export function capacityChangeHint(
    desiredBefore?: number | null,
    desiredAfter?: number | null,
    desiredBeforeSource?: string | null
): string | undefined {
    if (desiredBefore == null && desiredAfter != null) {
        return "Prior capacity is not reported by this source, and CloudWatch no longer has a datapoint for it either.";
    }
    if (desiredBefore != null && desiredBeforeSource === 'cloudwatch') {
        return "Prior capacity was not reported by this source — recovered from the DesiredTaskCount CloudWatch metric.";
    }
    return undefined;
}
