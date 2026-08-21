// web-ui/lib/network-availability-report.ts
//
// Pure aggregation for the Scale Sentinel "Direct Connect & VPN" compliance
// report. No fetch, no DB, no Date.now() — the caller supplies the samples
// and the window, so this is fully deterministic and unit-testable.
//
// Date formatting: components/scaling-audit/shared.ts's formatIstDateTime
// is the module's existing IST helper, but its preset ("MMM dd, yyyy HH:mm",
// no zone suffix) doesn't match this report's reference format
// ("13-Apr-2026 14:30 IST", day-first + literal "IST" suffix). Rather than
// silently diverge or reshape that shared helper (used elsewhere, out of
// scope here), this file formats the peak timestamp directly against
// date-fns-tz — the same dependency shared.ts itself is built on.
import { formatInTimeZone } from 'date-fns-tz';
import type { NetworkAvailabilityReportRow, NetworkLinkSample } from './db/repositories/network-links/interface';

const HOUR_MS = 60 * 60 * 1000;
const IST_TIMEZONE = 'Asia/Kolkata';

/** installedBandwidthMbps -> bits/second, for comparing against bpsAvgIn/bpsMaxIn/etc. */
function installedBps(installedMbps: number): number {
    return installedMbps * 1_000_000;
}

/** 1000 -> "1 Gbps", 1250 -> "1.25 Gbps", 400 -> "400 Mbps". */
function formatInstalledCapacity(installedMbps: number): string {
    if (installedMbps >= 1000) {
        const gbps = installedMbps / 1000;
        return `${gbps} Gbps`;
    }
    return `${installedMbps} Mbps`;
}

function formatPercent(value: number, decimals: number): string {
    return `${value.toFixed(decimals)}%`;
}

function formatMbps(bps: number): string {
    return `${(bps / 1_000_000).toFixed(2)} Mbps`;
}

function formatIstTimestamp(date: Date): string {
    return `${formatInTimeZone(date, IST_TIMEZONE, 'dd-MMM-yyyy HH:mm')} IST`;
}

function inWindow(sample: NetworkLinkSample, windowStart: Date, windowEnd: Date): boolean {
    const t = sample.bucketStartUtc.getTime();
    return t >= windowStart.getTime() && t < windowEnd.getTime();
}

/**
 * Fraction of hours (0..1) a group of resources was "up", where up = at
 * least one resource in the group had stateUp === true for that hour.
 * Pass a single resource's samples to get that resource's own uptime, or
 * every resource's samples to get the redundancy-aware combined uptime.
 *
 * Denominator is the total hours in the window, not "hours with any sample" —
 * a gap in monitoring isn't uptime, so it must not be silently dropped from
 * the denominator (that would flatter the percentage).
 */
function uptimeFraction(samplesByHour: Map<number, boolean>, totalHours: number): number {
    if (totalHours <= 0) return 0;
    let upHours = 0;
    for (const isUp of samplesByHour.values()) {
        if (isUp) upHours++;
    }
    return upHours / totalHours;
}

/** hour-bucket key (ms since epoch) -> was ANY sample in this group up that hour. */
function upByHour(samples: NetworkLinkSample[]): Map<number, boolean> {
    const map = new Map<number, boolean>();
    for (const s of samples) {
        const key = s.bucketStartUtc.getTime();
        const isUp = s.stateUp === true;
        map.set(key, (map.get(key) ?? false) || isUp);
    }
    return map;
}

interface PeakInfo {
    pct: number;
    bps: number;
    direction: 'Ingress' | 'Egress';
    at: Date;
}

/** The single (bucket, direction) pair with the highest bps as a % of installed capacity. */
function findPeak(samples: NetworkLinkSample[], installedMbps: number): PeakInfo | null {
    let peak: PeakInfo | null = null;
    const denom = installedBps(installedMbps);
    for (const s of samples) {
        const maxIn = s.bpsMaxIn ?? 0;
        const maxOut = s.bpsMaxOut ?? 0;
        const direction: 'Ingress' | 'Egress' = maxIn >= maxOut ? 'Ingress' : 'Egress';
        const bps = direction === 'Ingress' ? maxIn : maxOut;
        const pct = denom > 0 ? (bps / denom) * 100 : 0;
        if (!peak || pct > peak.pct) {
            peak = { pct, bps, direction, at: s.bucketStartUtc };
        }
    }
    return peak;
}

/** Distinct hourly buckets where either direction's max % exceeds 70. */
function countBreaches(samples: NetworkLinkSample[], installedMbps: number): number {
    const denom = installedBps(installedMbps);
    if (denom <= 0) return 0;
    let count = 0;
    for (const s of samples) {
        const maxBps = Math.max(s.bpsMaxIn ?? 0, s.bpsMaxOut ?? 0);
        if ((maxBps / denom) * 100 > 70) count++;
    }
    return count;
}

function average(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** One bandwidth row for a single DX/VPN resource. */
function buildBandwidthRow(
    label: string,
    samples: NetworkLinkSample[],
    installedMbps: number | null
): NetworkAvailabilityReportRow {
    if (installedMbps == null || installedMbps <= 0) {
        // Defensive: a resource with no known installed capacity can't be
        // turned into a % of anything meaningful.
        return {
            particulars: label,
            installedCapacity: 'N/A',
            utilisedCapacity: 'N/A',
            peakLoad: 'N/A',
            breachCount: null,
        };
    }

    const denom = installedBps(installedMbps);
    const avgInBps = average(samples.map((s) => s.bpsAvgIn ?? 0));
    const avgOutBps = average(samples.map((s) => s.bpsAvgOut ?? 0));
    const avgInPct = (avgInBps / denom) * 100;
    const avgOutPct = (avgOutBps / denom) * 100;

    const peak = findPeak(samples, installedMbps);
    const peakLoad = peak
        ? `${formatPercent(peak.pct, 2)} (${formatMbps(peak.bps)}, ${peak.direction}) on ${formatIstTimestamp(peak.at)}`
        : 'N/A';

    return {
        particulars: label,
        installedCapacity: formatInstalledCapacity(installedMbps),
        utilisedCapacity: `Avg Ingress ${formatPercent(avgInPct, 4)} (${formatMbps(avgInBps)}) / Avg Egress ${formatPercent(avgOutPct, 4)} (${formatMbps(avgOutBps)})`,
        peakLoad,
        breachCount: countBreaches(samples, installedMbps),
    };
}

export function buildNetworkAvailabilityReport(
    samples: NetworkLinkSample[],
    windowStart: Date,
    windowEnd: Date
): NetworkAvailabilityReportRow[] {
    const inRange = samples.filter((s) => inWindow(s, windowStart, windowEnd));
    if (inRange.length === 0) return [];

    const totalHours = Math.max(0, Math.round((windowEnd.getTime() - windowStart.getTime()) / HOUR_MS));

    // Group by resourceId, preserving first-seen order (dx_connection first,
    // then vpn_tunnel resources in the order they first appear).
    const dxGroups: { resourceId: string; samples: NetworkLinkSample[] }[] = [];
    const vpnGroups: { resourceId: string; samples: NetworkLinkSample[] }[] = [];
    const groupIndex = new Map<string, { samples: NetworkLinkSample[] }>();

    for (const s of inRange) {
        let group = groupIndex.get(s.resourceId);
        if (!group) {
            group = { samples: [] };
            groupIndex.set(s.resourceId, group);
            const entry = { resourceId: s.resourceId, samples: group.samples };
            if (s.resourceType === 'dx_connection') {
                dxGroups.push(entry);
            } else {
                vpnGroups.push(entry);
            }
        }
        group.samples.push(s);
    }

    // Defensively handle zero-or-many DX connections: only the first is used
    // for the "DX only" row (a tenant is expected to have exactly one).
    const dxGroup = dxGroups[0] ?? null;

    const rows: NetworkAvailabilityReportRow[] = [];

    // Row 1: DX-only availability.
    if (dxGroup) {
        const dxUptime = uptimeFraction(upByHour(dxGroup.samples), totalHours);
        rows.push({
            particulars: 'Network availability — DX only',
            installedCapacity: '100%',
            utilisedCapacity: formatPercent(dxUptime * 100, 2),
            peakLoad: 'N/A',
            breachCount: null,
        });
    } else {
        rows.push({
            particulars: 'Network availability — DX only',
            installedCapacity: '100%',
            utilisedCapacity: 'N/A',
            peakLoad: 'N/A',
            breachCount: null,
        });
    }

    // Row 2: combined redundancy-aware availability — up if ANY resource
    // (DX or any VPN backup) was up that hour.
    const combinedUpByHour = new Map<number, boolean>();
    for (const group of [...dxGroups, ...vpnGroups]) {
        for (const [hourKey, isUp] of upByHour(group.samples)) {
            combinedUpByHour.set(hourKey, (combinedUpByHour.get(hourKey) ?? false) || isUp);
        }
    }
    const combinedUptime = uptimeFraction(combinedUpByHour, totalHours);
    rows.push({
        particulars: 'Network availability — DX + VPN backup combined',
        installedCapacity: '100% (redundant paths)',
        // 4dp (vs 2dp for the DX-only row) — matches the reference report,
        // which needs the extra precision to show this is genuinely close
        // to 100% rather than a rounded illusion.
        utilisedCapacity: formatPercent(combinedUptime * 100, 4),
        peakLoad: 'N/A',
        breachCount: null,
    });

    // Row 3: DX bandwidth (primary link).
    if (dxGroup) {
        const dxDisplayName = dxGroup.samples[0]?.displayName ?? dxGroup.resourceId;
        rows.push(buildBandwidthRow(`Bandwidth — ${dxDisplayName} (primary)`, dxGroup.samples, dxGroup.samples[0]?.installedBandwidthMbps ?? null));
    }

    // Row(s) 4+: one per VPN backup tunnel, in first-seen order.
    for (const group of vpnGroups) {
        const displayName = group.samples[0]?.displayName ?? group.resourceId;
        rows.push(buildBandwidthRow(`Bandwidth — ${displayName} (backup)`, group.samples, group.samples[0]?.installedBandwidthMbps ?? null));
    }

    return rows;
}
