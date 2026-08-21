// workers/src/jobs/spot-guard/report/aggregate.ts
//
// Pure folding of the hours query into a report tree, plus the Slack digest text (SG-009).
// No I/O and no clock reads, so every shaping decision below is unit-testable.
import type { HoursRow, DataQualityRow } from './query.js';

const SECONDS_PER_HOUR = 3600;

export interface ServiceHours {
    serviceName: string;
    spotSeconds: number;
    onDemandSeconds: number;
    spotHours: number;
    onDemandHours: number;
    /** Share of this service's total running time spent on Spot, 0..1. */
    spotShare: number;
    sessions: number;
    inFlightSessions: number;
    interruptions: number;
}

export interface ClusterHours {
    clusterName: string;
    region: string;
    services: ServiceHours[];
    spotSeconds: number;
    onDemandSeconds: number;
}

export interface AccountHours {
    accountId: string;
    accountName: string;
    clusters: ClusterHours[];
    spotSeconds: number;
    onDemandSeconds: number;
}

export interface HoursReport {
    from: string;
    to: string;
    accounts: AccountHours[];
    totals: {
        spotSeconds: number;
        onDemandSeconds: number;
        spotHours: number;
        onDemandHours: number;
        spotShare: number;
        sessions: number;
        inFlightSessions: number;
        interruptions: number;
        estimatedSavings: number | null;
    };
    dataQuality: DataQualityRow;
}

export const toHours = (seconds: number): number => Math.round((seconds / SECONDS_PER_HOUR) * 100) / 100;

/** Share of running time on Spot. Returns 0 for a service with no running time at all. */
export function spotShareOf(spotSeconds: number, onDemandSeconds: number): number {
    const total = spotSeconds + onDemandSeconds;
    if (total <= 0) return 0;
    return Math.round((spotSeconds / total) * 10000) / 10000;
}

/**
 * Fold flat (account, cluster, service, capacityType) rows into the report tree.
 *
 * `accountNames` maps AWS account id -> display name. The reference implementation needed
 * a whole DynamoDB table plus a CloudFormation custom-resource seeder for this, because
 * organizations:DescribeAccount only works from an Org management account. Nucleus already
 * has the name on the `accounts` row, so the mapping is just a join — no extra table.
 *
 * `spotDiscount` is the assumed Spot price reduction (Fargate Spot is ~70% off list). When
 * omitted, estimatedSavings is null rather than 0 — an unknown saving and a zero saving
 * are different claims, and reporting 0 would understate the feature's value.
 */
export function aggregateHours(
    rows: HoursRow[],
    opts: {
        from: Date;
        to: Date;
        accountNames?: Record<string, string>;
        dataQuality?: DataQualityRow;
        /** Blended On-Demand $/hour for a task, if known. */
        onDemandRatePerHour?: number;
        spotDiscount?: number;
    },
): HoursReport {
    const accounts = new Map<string, AccountHours>();
    const totals = {
        spotSeconds: 0,
        onDemandSeconds: 0,
        sessions: 0,
        inFlightSessions: 0,
        interruptions: 0,
    };

    for (const row of rows) {
        const account = accounts.get(row.accountId) ?? {
            accountId: row.accountId,
            accountName: opts.accountNames?.[row.accountId] ?? row.accountId,
            clusters: [],
            spotSeconds: 0,
            onDemandSeconds: 0,
        };
        accounts.set(row.accountId, account);

        // Cluster identity includes the region: the same cluster name can exist in two
        // regions, and merging them would silently double a service's hours.
        let cluster = account.clusters.find((c) => c.clusterName === row.clusterName && c.region === row.region);
        if (!cluster) {
            cluster = { clusterName: row.clusterName, region: row.region, services: [], spotSeconds: 0, onDemandSeconds: 0 };
            account.clusters.push(cluster);
        }

        let service = cluster.services.find((s) => s.serviceName === row.serviceName);
        if (!service) {
            service = {
                serviceName: row.serviceName,
                spotSeconds: 0,
                onDemandSeconds: 0,
                spotHours: 0,
                onDemandHours: 0,
                spotShare: 0,
                sessions: 0,
                inFlightSessions: 0,
                interruptions: 0,
            };
            cluster.services.push(service);
        }

        // One input row per capacityType, so a service accumulates from two rows.
        if (row.capacityType === 'spot') {
            service.spotSeconds += row.seconds;
            cluster.spotSeconds += row.seconds;
            account.spotSeconds += row.seconds;
            totals.spotSeconds += row.seconds;
        } else {
            service.onDemandSeconds += row.seconds;
            cluster.onDemandSeconds += row.seconds;
            account.onDemandSeconds += row.seconds;
            totals.onDemandSeconds += row.seconds;
        }
        service.sessions += row.sessions;
        service.inFlightSessions += row.inFlightSessions;
        service.interruptions += row.interruptions;
        totals.sessions += row.sessions;
        totals.inFlightSessions += row.inFlightSessions;
        totals.interruptions += row.interruptions;
    }

    // Derived per-service fields, and a stable ordering so a diff between two runs is
    // meaningful rather than noise from Map iteration order.
    for (const account of accounts.values()) {
        for (const cluster of account.clusters) {
            for (const service of cluster.services) {
                service.spotHours = toHours(service.spotSeconds);
                service.onDemandHours = toHours(service.onDemandSeconds);
                service.spotShare = spotShareOf(service.spotSeconds, service.onDemandSeconds);
            }
            cluster.services.sort((a, b) => a.serviceName.localeCompare(b.serviceName));
        }
        account.clusters.sort(
            (a, b) => a.clusterName.localeCompare(b.clusterName) || a.region.localeCompare(b.region),
        );
    }

    const estimatedSavings =
        opts.onDemandRatePerHour !== undefined && opts.spotDiscount !== undefined
            ? Math.round(toHours(totals.spotSeconds) * opts.onDemandRatePerHour * opts.spotDiscount * 100) / 100
            : null;

    return {
        from: opts.from.toISOString(),
        to: opts.to.toISOString(),
        accounts: [...accounts.values()].sort((a, b) => a.accountId.localeCompare(b.accountId)),
        totals: {
            ...totals,
            spotHours: toHours(totals.spotSeconds),
            onDemandHours: toHours(totals.onDemandSeconds),
            spotShare: spotShareOf(totals.spotSeconds, totals.onDemandSeconds),
            estimatedSavings,
        },
        dataQuality: opts.dataQuality ?? { orphaned: 0, staleOpen: 0 },
    };
}

/**
 * Slack digest. Keeps the reference implementation's Account -> Cluster -> Service
 * hierarchy and emoji so the message is familiar to anyone who read the old one.
 *
 * Uses plain `text` rather than attachments — the reference set attachment colours like
 * "#warning" and "#good", which are neither Slack colour keywords nor hex codes, so they
 * were silently ignored. Not worth reproducing a decoration that never worked.
 */
export function formatSlackDigest(report: HoursReport, opts: { reportDate: string }): string {
    const lines: string[] = [`:date: *Fargate Spot Guard — daily report for ${opts.reportDate}*`];

    if (report.accounts.length === 0) {
        lines.push('', '_No ECS Spot activity recorded for this period._');
        return lines.join('\n');
    }

    const pct = (share: number) => `${Math.round(share * 100)}%`;

    lines.push(
        '',
        `*Total:* ${report.totals.spotHours.toFixed(2)} hrs Spot / ${report.totals.onDemandHours.toFixed(2)} hrs On-Demand (${pct(report.totals.spotShare)} on Spot)`,
    );
    if (report.totals.interruptions > 0) {
        lines.push(`*Interruptions:* ${report.totals.interruptions}`);
    }
    if (report.totals.estimatedSavings !== null) {
        lines.push(`*Estimated saving:* ~$${report.totals.estimatedSavings.toFixed(2)}`);
    }

    for (const account of report.accounts) {
        lines.push('', '---', `:office: *${account.accountName}* (\`${account.accountId}\`)`);
        for (const cluster of account.clusters) {
            lines.push(`  :wheel_of_dharma: *${cluster.clusterName}* — ${cluster.region}`);
            for (const s of cluster.services) {
                const flags: string[] = [];
                // Surface these inline rather than only in the footer: a reader looking at
                // one service's number needs to know part of it is still accruing.
                if (s.inFlightSessions > 0) flags.push(`${s.inFlightSessions} running`);
                if (s.interruptions > 0) flags.push(`${s.interruptions} interrupted`);
                const suffix = flags.length > 0 ? `  _(${flags.join(', ')})_` : '';
                lines.push(
                    `    :small_blue_diamond: ${s.serviceName} — Spot ${s.spotHours.toFixed(2)} hrs | On-Demand ${s.onDemandHours.toFixed(2)} hrs | ${pct(s.spotShare)} Spot${suffix}`,
                );
            }
        }
    }

    // Data-quality footer. The reference reported nothing here, so lost events silently
    // became "0 hours" and looked like an idle service.
    const dq: string[] = [];
    if (report.dataQuality.orphaned > 0) {
        dq.push(`${report.dataQuality.orphaned} session(s) excluded (no start event recorded)`);
    }
    if (report.dataQuality.staleOpen > 0) {
        dq.push(`${report.dataQuality.staleOpen} session(s) still open after 7 days (likely a dropped stop event)`);
    }
    if (dq.length > 0) {
        lines.push('', `:warning: _Data quality: ${dq.join('; ')}._`);
    }

    return lines.join('\n');
}
