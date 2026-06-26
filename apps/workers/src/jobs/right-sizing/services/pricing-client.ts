// workers/src/jobs/right-sizing/services/pricing-client.ts
//
// AWS Price List Query API client (RS-006).
// Fetches on-demand pricing + type metadata for EC2, RDS, and EBS and maps it to
// PricingEntry rows. Runs from the platform account (the worker's own credentials) —
// it does NOT AssumeRole into tenant accounts.
//
// The Price List API is a global service; we call the us-east-1 endpoint.
import {
    PricingClient,
    GetProductsCommand,
    type Filter,
} from '@aws-sdk/client-pricing';
import { createLogger } from '../../../lib/logger.js';

const log = createLogger('right-sizing-pricing-client');
const PRICING_ENDPOINT_REGION = 'us-east-1';

export interface PricingEntry {
    region: string;
    serviceCode: string; // AmazonEC2 | AmazonRDS | AmazonEBS
    resourceClass: string;
    attributes: Record<string, unknown>;
    pricePerHour?: number | null;
    pricePerGiBMonth?: number | null;
    pricePerIopsMonth?: number | null;
    currency?: string;
}

let client: PricingClient | null = null;
function getClient(): PricingClient {
    if (!client) client = new PricingClient({ region: PRICING_ENDPOINT_REGION });
    return client;
}

/** Extract the first on-demand USD price-per-unit from a parsed PriceList product. */
function extractOnDemandUsd(product: Record<string, unknown>): number | null {
    const terms = product.terms as Record<string, unknown> | undefined;
    const onDemand = terms?.OnDemand as Record<string, unknown> | undefined;
    if (!onDemand) return null;
    for (const term of Object.values(onDemand)) {
        const dims = (term as Record<string, unknown>).priceDimensions as Record<string, unknown> | undefined;
        if (!dims) continue;
        for (const dim of Object.values(dims)) {
            const ppu = (dim as Record<string, unknown>).pricePerUnit as Record<string, string> | undefined;
            const usd = ppu?.USD;
            if (usd != null) {
                const n = parseFloat(usd);
                if (!Number.isNaN(n)) return n;
            }
        }
    }
    return null;
}

async function getProducts(serviceCode: string, filters: Filter[]): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    let nextToken: string | undefined;
    let attempt = 0;
    do {
        try {
            const resp = await getClient().send(
                new GetProductsCommand({ ServiceCode: serviceCode, Filters: filters, NextToken: nextToken, MaxResults: 100 })
            );
            for (const raw of resp.PriceList ?? []) {
                try {
                    out.push(JSON.parse(raw as string) as Record<string, unknown>);
                } catch {
                    /* skip unparseable entry */
                }
            }
            nextToken = resp.NextToken;
            attempt = 0;
        } catch (err) {
            attempt += 1;
            if (attempt > 3) throw err;
            const backoff = 250 * 2 ** attempt;
            await new Promise((r) => setTimeout(r, backoff));
        }
    } while (nextToken);
    return out;
}

function eq(field: string, value: string): Filter {
    return { Type: 'TERM_MATCH', Field: field, Value: value };
}

/** EC2 on-demand Linux/Shared pricing for a region. */
export async function fetchEc2Pricing(region: string): Promise<PricingEntry[]> {
    const products = await getProducts('AmazonEC2', [
        eq('regionCode', region),
        eq('operatingSystem', 'Linux'),
        eq('tenancy', 'Shared'),
        eq('capacitystatus', 'Used'),
        eq('preInstalledSw', 'NA'),
    ]);
    const entries: PricingEntry[] = [];
    for (const p of products) {
        const attrs = ((p.product as Record<string, unknown>)?.attributes ?? {}) as Record<string, string>;
        const instanceType = attrs.instanceType;
        if (!instanceType) continue;
        const price = extractOnDemandUsd(p);
        entries.push({
            region,
            serviceCode: 'AmazonEC2',
            resourceClass: instanceType,
            attributes: {
                vcpu: attrs.vcpu ? Number(attrs.vcpu) : undefined,
                memGiB: attrs.memory ? parseFloat(attrs.memory) : undefined,
                family: attrs.instanceFamily,
                physicalProcessor: attrs.physicalProcessor,
            },
            pricePerHour: price,
        });
    }
    log.info(`Fetched ${entries.length} EC2 price entries for ${region}`);
    return entries;
}

/** RDS on-demand Single-AZ pricing for a region (all engines). */
export async function fetchRdsPricing(region: string): Promise<PricingEntry[]> {
    const products = await getProducts('AmazonRDS', [
        eq('regionCode', region),
        eq('deploymentOption', 'Single-AZ'),
    ]);
    const entries: PricingEntry[] = [];
    for (const p of products) {
        const attrs = ((p.product as Record<string, unknown>)?.attributes ?? {}) as Record<string, string>;
        const dbClass = attrs.instanceType;
        if (!dbClass) continue;
        const price = extractOnDemandUsd(p);
        entries.push({
            region,
            serviceCode: 'AmazonRDS',
            resourceClass: dbClass,
            attributes: {
                vcpu: attrs.vcpu ? Number(attrs.vcpu) : undefined,
                memGiB: attrs.memory ? parseFloat(attrs.memory) : undefined,
                databaseEngine: attrs.databaseEngine,
                family: attrs.instanceFamily,
            },
            pricePerHour: price,
        });
    }
    log.info(`Fetched ${entries.length} RDS price entries for ${region}`);
    return entries;
}

/** EBS volume ($/GiB-month) + provisioned IOPS pricing for a region. */
export async function fetchEbsPricing(region: string): Promise<PricingEntry[]> {
    const storage = await getProducts('AmazonEC2', [eq('regionCode', region), eq('productFamily', 'Storage')]);
    const iops = await getProducts('AmazonEC2', [eq('regionCode', region), eq('productFamily', 'System Operation')]);

    const byType = new Map<string, PricingEntry>();
    for (const p of storage) {
        const attrs = ((p.product as Record<string, unknown>)?.attributes ?? {}) as Record<string, string>;
        const volType = attrs.volumeApiName; // gp2, gp3, io1, io2, st1, sc1, standard
        if (!volType) continue;
        byType.set(volType, {
            region,
            serviceCode: 'AmazonEBS',
            resourceClass: volType,
            attributes: { storageMedia: attrs.storageMedia, volumeType: attrs.volumeType },
            pricePerGiBMonth: extractOnDemandUsd(p),
        });
    }
    // Attach provisioned-IOPS price ($/IOPS-month) where applicable.
    for (const p of iops) {
        const attrs = ((p.product as Record<string, unknown>)?.attributes ?? {}) as Record<string, string>;
        const volType = attrs.volumeApiName;
        if (!volType) continue;
        const entry = byType.get(volType);
        if (entry) entry.pricePerIopsMonth = extractOnDemandUsd(p);
    }
    const entries = [...byType.values()];
    log.info(`Fetched ${entries.length} EBS price entries for ${region}`);
    return entries;
}

/** Fetch all supported services for a region. Per-service failures are isolated. */
export async function fetchAllPricing(region: string): Promise<PricingEntry[]> {
    const results: PricingEntry[] = [];
    for (const [name, fn] of [
        ['EC2', fetchEc2Pricing],
        ['RDS', fetchRdsPricing],
        ['EBS', fetchEbsPricing],
    ] as const) {
        try {
            results.push(...(await fn(region)));
        } catch (err) {
            log.error(`Failed to fetch ${name} pricing for ${region}`, { error: String(err) });
        }
    }
    return results;
}
