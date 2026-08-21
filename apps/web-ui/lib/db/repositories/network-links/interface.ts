/**
 * INetworkLinksRepository
 *
 * Read contract for the "Direct Connect & VPN" compliance report inside Scale
 * Sentinel — hourly link-health/bandwidth samples for a tenant's Direct
 * Connect connections and their VPN backup tunnels. Implemented by a
 * Postgres repository backed by the workers-side hourly poller (aws_api).
 *
 * `NetworkLinkSample` is the canonical shape: the workers Prisma model and
 * the Postgres repository implementation must match these field names and
 * types exactly — this file is the contract they are built against.
 *
 * Multi-tenant safety: every query is scoped by tenantId via getTenantClient().
 */

export interface NetworkLinkSample {
    tenantId: string;
    accountId: string;
    region: string;
    resourceType: 'dx_connection' | 'vpn_tunnel';
    /** DX: connectionId. VPN: `${vpnConnectionId}:${outsideIpAddress}`. */
    resourceId: string;
    /** AWS Name tag if present, else null. */
    displayName: string | null;
    installedBandwidthMbps: number | null;
    bpsAvgIn: number | null;
    bpsMaxIn: number | null;
    bpsAvgOut: number | null;
    bpsMaxOut: number | null;
    /** true only if up for the WHOLE bucket hour. */
    stateUp: boolean | null;
    /** One row per resource per hour. */
    bucketStartUtc: Date;
}

/**
 * One row of the Direct Connect & VPN availability/bandwidth report.
 *
 * `installedCapacity`, `utilisedCapacity`, and `peakLoad` are pre-formatted
 * display strings (not raw numbers) — e.g. "45.73% (457.33 Mbps, Ingress) on
 * 13-Apr-2026 14:30 IST" — since the report renders them verbatim in a table
 * cell. `breachCount` is `null` for the two availability rows ("No. of
 * instances >70%" is N/A there — that column only means something for a
 * per-link bandwidth row).
 */
export interface NetworkAvailabilityReportRow {
    particulars: string;
    installedCapacity: string;
    utilisedCapacity: string;
    peakLoad: string;
    breachCount: number | null;
}

/** Inclusive, ISO date/datetime strings — filters on bucketStartUtc. */
export interface NetworkLinkSampleFilters {
    accountId?: string;
    region?: string;
    dateFrom?: string;
    dateTo?: string;
}

export interface INetworkLinksRepository {
    listSamples(tenantId: string, filters: NetworkLinkSampleFilters): Promise<NetworkLinkSample[]>;
}
