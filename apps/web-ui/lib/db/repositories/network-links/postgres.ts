/**
 * NetworkLinksPostgresRepository
 *
 * PostgreSQL implementation of INetworkLinksRepository using Prisma ORM.
 * Reads `network_link_samples` — hourly bandwidth/availability samples for a
 * tenant's Direct Connect connections and VPN backup tunnels.
 *
 * Multi-tenant safety: every query goes through getTenantClient(tenantId).
 * Read-only by design — no update/delete method exists here or in the interface.
 */
import { getTenantClient } from '@/lib/db/pg-config';
import { istDayRangeFilter } from '@/lib/ist-date-range';
import type { INetworkLinksRepository, NetworkLinkSample, NetworkLinkSampleFilters } from './interface';

interface SampleRow {
    tenantId: string;
    accountId: string;
    region: string;
    resourceType: string;
    resourceId: string;
    displayName: string | null;
    installedBandwidthMbps: number | null;
    bpsAvgIn: number | null;
    bpsMaxIn: number | null;
    bpsAvgOut: number | null;
    bpsMaxOut: number | null;
    stateUp: boolean | null;
    bucketStartUtc: Date;
}

function transformSample(row: SampleRow): NetworkLinkSample {
    return {
        tenantId: row.tenantId,
        accountId: row.accountId,
        region: row.region,
        resourceType: row.resourceType as NetworkLinkSample['resourceType'],
        resourceId: row.resourceId,
        displayName: row.displayName,
        installedBandwidthMbps: row.installedBandwidthMbps,
        bpsAvgIn: row.bpsAvgIn,
        bpsMaxIn: row.bpsMaxIn,
        bpsAvgOut: row.bpsAvgOut,
        bpsMaxOut: row.bpsMaxOut,
        stateUp: row.stateUp,
        bucketStartUtc: row.bucketStartUtc,
    };
}

function buildWhere(tenantId: string, filters: NetworkLinkSampleFilters): Record<string, unknown> {
    const { accountId, region, dateFrom, dateTo } = filters;
    const where: Record<string, unknown> = { tenantId };
    if (accountId) where.accountId = accountId;
    if (region) where.region = region;
    const dayRange = istDayRangeFilter(dateFrom, dateTo);
    if (dayRange) where.bucketStartUtc = dayRange;
    return where;
}

export class NetworkLinksPostgresRepository implements INetworkLinksRepository {
    async listSamples(tenantId: string, filters: NetworkLinkSampleFilters): Promise<NetworkLinkSample[]> {
        const client = getTenantClient(tenantId);
        const where = buildWhere(tenantId, filters);
        // Ascending — buildNetworkAvailabilityReport iterates samples chronologically
        // (upByHour/findPeak assume first-seen order for peak-timestamp reporting).
        const rows = await client.networkLinkSample.findMany({ where, orderBy: { bucketStartUtc: 'asc' } });
        return (rows as SampleRow[]).map(transformSample);
    }
}
