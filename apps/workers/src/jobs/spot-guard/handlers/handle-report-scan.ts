// workers/src/jobs/spot-guard/handlers/handle-report-scan.ts
//
// Daily per-tenant Spot-vs-On-Demand hours report (SG-009) — the port of the reference's
// aggregator Lambda.
//
// Runs THROUGH the executor: it is a read-only aggregation over a tenant's whole session
// history, so retries are safe (retryLimit 2 on the queue, unlike the restore scan's 0).
import { createLogger } from '../../../lib/logger.js';
import { writeAuditLog } from '../../discovery/services/audit-service.js';
import { getPool } from '../../discovery/services/db.js';
import { SPOT_GUARD_CONFIG } from '../config.js';
import type { SpotGuardReportJob } from '../types.js';
import { queryDataQuality, queryHours } from '../report/query.js';
import { aggregateHours, formatSlackDigest } from '../report/aggregate.js';
import { reportDateFor } from '../services/db-writer.js';
import { notify } from '../services/notifier.js';

const log = createLogger('spot-guard-report');

/**
 * Account id -> display name for this tenant.
 *
 * The reference needed a dedicated DynamoDB table plus a CloudFormation custom-resource
 * seeder for this, because organizations:DescribeAccount only works from an Org
 * management account and its hub was a member account. Nucleus already stores the name on
 * the accounts row, so it is just a lookup.
 */
async function accountNamesFor(tenantId: string): Promise<Record<string, string>> {
    const client = await getPool().connect();
    try {
        const { rows } = await client.query<{ accountId: string; name: string }>(
            `SELECT "accountId", name FROM accounts WHERE "tenantId" = $1`,
            [tenantId],
        );
        return Object.fromEntries(rows.map((r) => [r.accountId, r.name]));
    } finally {
        client.release();
    }
}

/** Per-tenant report timezone, defaulting to UTC. */
async function reportTimezoneFor(tenantId: string): Promise<string> {
    const client = await getPool().connect();
    try {
        const { rows } = await client.query<{ data: { reportTimezone?: string } | null }>(
            `SELECT data FROM tenant_configs WHERE "tenantId" = $1 AND "configKey" = 'spot-guard'`,
            [tenantId],
        );
        return rows[0]?.data?.reportTimezone ?? SPOT_GUARD_CONFIG.defaultReportTimezone;
    } catch {
        // A missing or malformed config must not fail the report.
        return SPOT_GUARD_CONFIG.defaultReportTimezone;
    } finally {
        client.release();
    }
}

/**
 * Window for a calendar day in a given timezone.
 *
 * Built by asking for the day's boundaries as instants, which is the only correct way once
 * a report timezone is in play: "the 20th in Asia/Kolkata" starts at 18:30 UTC on the
 * 19th, not at midnight UTC.
 */
export function dayWindow(dateStr: string, timeZone: string): { from: Date; to: Date } {
    // Offset of the target zone at roughly the requested date, derived by formatting a
    // known instant in that zone and diffing. Avoids pulling in a tz library for what is
    // a single arithmetic step.
    const probe = new Date(`${dateStr}T12:00:00Z`);
    const asUtc = new Date(probe.toLocaleString('en-US', { timeZone: 'UTC' }));
    const asZone = new Date(probe.toLocaleString('en-US', { timeZone }));
    const offsetMs = asZone.getTime() - asUtc.getTime();

    const localMidnight = new Date(`${dateStr}T00:00:00Z`).getTime();
    return { from: new Date(localMidnight - offsetMs), to: new Date(localMidnight - offsetMs + 86_400_000) };
}

/** Yesterday's date string in the given timezone — the day that just ended. */
function previousDay(now: Date, timeZone: string): string {
    return reportDateFor(new Date(now.getTime() - 86_400_000), timeZone);
}

export async function handleSpotGuardReport(jobData: unknown): Promise<void> {
    const { tenantId, trigger, date } = jobData as SpotGuardReportJob;
    const now = new Date();

    const timeZone = await reportTimezoneFor(tenantId);
    // Default to the day that just ENDED, not today. The reference reported "today so
    // far", which meant its daily digest was always a partial day — and its own comment
    // claimed otherwise.
    const reportDate = date ?? previousDay(now, timeZone);
    const { from, to } = dayWindow(reportDate, timeZone);

    const [rows, dataQuality, accountNames] = await Promise.all([
        queryHours({ tenantId, from, to, now }),
        queryDataQuality({ tenantId, from, now }),
        accountNamesFor(tenantId),
    ]);

    const report = aggregateHours(rows, { from, to, accountNames, dataQuality });
    const digest = formatSlackDigest(report, { reportDate });

    // Delivered to the tenant's Slack when they have one configured, and always logged so
    // the report stays verifiable in sandbox regardless.
    //
    // alertType 'spot_enabled' is reused here purely for its ZERO dedup window: a daily
    // digest must never be suppressed, and the taxonomy's other windows (300s-3600s) all
    // would suppress nothing anyway at a 24h cadence. Kept explicit rather than inventing a
    // 'report' alert type, which would need a matching CHECK-constraint value for no
    // behavioural gain.
    await notify({
        tenantId,
        accountId: 'n/a',
        region: 'n/a',
        clusterName: 'n/a',
        serviceName: 'daily-report',
        eventType: 'spot_enabled',
        severity: 'info',
        alertType: 'spot_enabled',
        message: `Daily Spot Guard report for ${reportDate}.`,
        slackText: digest,
        // Pre-formatted multi-line body: web-ui must not reshape it into the compact alert layout.
        slackLayout: 'digest',
        metadata: { reportDate, timeZone, totals: report.totals, dataQuality },
    }).catch((err) =>
        // Never let a notification problem fail the report job.
        log.error('Failed to deliver Spot Guard daily digest', {
            error: err instanceof Error ? err.message : String(err),
        }),
    );

    log.info('Spot Guard daily report', {
        tenantId,
        reportDate,
        timeZone,
        spotHours: report.totals.spotHours,
        onDemandHours: report.totals.onDemandHours,
        spotSharePct: Math.round(report.totals.spotShare * 100),
        interruptions: report.totals.interruptions,
        inFlightSessions: report.totals.inFlightSessions,
        orphanedSessions: dataQuality.orphaned,
        staleOpenSessions: dataQuality.staleOpen,
        accounts: report.accounts.length,
    });
    log.debug('Spot Guard daily digest', { tenantId, digest });

    await writeAuditLog({
        tenantId,
        eventType: 'spot_guard.report.generated',
        action: 'Spot Guard daily report generated',
        resourceId: `spot-guard-report-${tenantId}-${reportDate}`,
        status: 'success',
        severity: 'info',
        details: `${reportDate} (${timeZone}): ${report.totals.spotHours.toFixed(2)} hrs Spot / ${report.totals.onDemandHours.toFixed(2)} hrs On-Demand across ${report.accounts.length} account(s).`,
        metadata: {
            trigger,
            reportDate,
            timeZone,
            totals: report.totals,
            dataQuality,
        },
    });
}
