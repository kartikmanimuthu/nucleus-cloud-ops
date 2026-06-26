// workers/src/jobs/right-sizing/services/db-writer.ts
//
// Raw-pg persistence for the right-sizing worker (RS-015).
// NOTE: raw SQL is NOT intercepted by any tenant extension — every query here scopes
// tenantId manually (CLAUDE.md gotcha).
import type { PoolClient } from 'pg';
import { getPool } from '../../discovery/services/db.js';
import { createLogger } from '../../../lib/logger.js';
import { RESOURCE_TYPES, type AnalyzableResource, type RecommendationOutput, type ResourceTypeKey } from '../types.js';
import type { CatalogApi, CatalogEntry } from './engine.js';

const log = createLogger('right-sizing-db-writer');

const ANALYZED_TYPES: ResourceTypeKey[] = [
    RESOURCE_TYPES.EC2,
    RESOURCE_TYPES.RDS,
    RESOURCE_TYPES.EBS,
    RESOURCE_TYPES.ASG,
];

/** Read all analyzable resources for a tenant from inventory. */
export async function getAnalyzableResources(tenantId: string): Promise<AnalyzableResource[]> {
    const client: PoolClient = await getPool().connect();
    try {
        const result = await client.query(
            `SELECT "accountId", region, "resourceType", "resourceId", name, status, metadata
             FROM inventory_resources
             WHERE "tenantId" = $1 AND "resourceType" = ANY($2::text[])`,
            [tenantId, ANALYZED_TYPES]
        );
        return result.rows.map((r) => ({
            accountId: r.accountId,
            region: r.region,
            resourceType: r.resourceType as ResourceTypeKey,
            resourceId: r.resourceId,
            name: r.name,
            status: r.status,
            metadata: (r.metadata as Record<string, unknown>) ?? {},
        }));
    } finally {
        client.release();
    }
}

/** Load pricing for the given regions into an in-memory CatalogApi (sync lookups). */
export async function loadCatalog(regions: string[]): Promise<CatalogApi> {
    const client: PoolClient = await getPool().connect();
    const byKey = new Map<string, CatalogEntry>();
    const byService = new Map<string, CatalogEntry[]>();
    try {
        const result = await client.query(
            `SELECT region, "serviceCode", "resourceClass", attributes,
                    "pricePerHour", "pricePerGiBMonth", "pricePerIopsMonth"
             FROM pricing_catalog
             WHERE region = ANY($1::text[])`,
            [regions.length ? regions : ['__none__']]
        );
        for (const r of result.rows) {
            const entry: CatalogEntry = {
                region: r.region,
                serviceCode: r.serviceCode,
                resourceClass: r.resourceClass,
                pricePerHour: r.pricePerHour,
                pricePerGiBMonth: r.pricePerGiBMonth,
                pricePerIopsMonth: r.pricePerIopsMonth,
                attributes: (r.attributes as CatalogEntry['attributes']) ?? {},
            };
            byKey.set(`${entry.serviceCode}|${entry.region}|${entry.resourceClass}`, entry);
            const sk = `${entry.serviceCode}|${entry.region}`;
            (byService.get(sk) ?? byService.set(sk, []).get(sk)!).push(entry);
        }
    } finally {
        client.release();
    }
    return {
        getPrice: (service, region, cls) => byKey.get(`${service}|${region}|${cls}`) ?? null,
        listClasses: (service, region) => byService.get(`${service}|${region}`) ?? [],
    };
}

/** Upsert computed recommendations for a tenant. Preserves reviewer status on existing rows. */
export async function upsertRecommendations(
    tenantId: string,
    outputs: RecommendationOutput[],
    runId: string
): Promise<number> {
    if (!outputs.length) return 0;
    const client: PoolClient = await getPool().connect();
    let written = 0;
    try {
        for (const o of outputs) {
            await client.query(
                `INSERT INTO right_sizing_recommendations
                    (id, "tenantId", "accountId", region, "resourceType", "resourceId", name, finding,
                     "currentConfig", "recommendedConfig", "metricsSummary", "lookbackDays", currency,
                     "currentMonthlyCost", "recommendedMonthlyCost", "estimatedMonthlySavings", confidence,
                     "riskLevel", rationale, source, status, "generatedByRunId", "generatedAt", "updatedAt")
                 VALUES (gen_random_uuid()::text, $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,
                         $13,$14,$15,$16,$17,$18,$19,'open',$20, now(), now())
                 ON CONFLICT ("tenantId","accountId","resourceType","resourceId")
                 DO UPDATE SET region = EXCLUDED.region, name = EXCLUDED.name, finding = EXCLUDED.finding,
                     "currentConfig" = EXCLUDED."currentConfig", "recommendedConfig" = EXCLUDED."recommendedConfig",
                     "metricsSummary" = EXCLUDED."metricsSummary", "lookbackDays" = EXCLUDED."lookbackDays",
                     currency = EXCLUDED.currency, "currentMonthlyCost" = EXCLUDED."currentMonthlyCost",
                     "recommendedMonthlyCost" = EXCLUDED."recommendedMonthlyCost",
                     "estimatedMonthlySavings" = EXCLUDED."estimatedMonthlySavings", confidence = EXCLUDED.confidence,
                     "riskLevel" = EXCLUDED."riskLevel", rationale = EXCLUDED.rationale,
                     "generatedByRunId" = EXCLUDED."generatedByRunId", "updatedAt" = now()`,
                [
                    tenantId, o.accountId, o.region, o.resourceType, o.resourceId, o.name ?? null, o.finding,
                    JSON.stringify(o.currentConfig ?? {}), o.recommendedConfig ? JSON.stringify(o.recommendedConfig) : null,
                    JSON.stringify(o.metricsSummary ?? {}), o.lookbackDays, o.currency,
                    o.currentMonthlyCost ?? null, o.recommendedMonthlyCost ?? null, o.estimatedMonthlySavings,
                    o.confidence, o.riskLevel, o.rationale, o.source, runId,
                ]
            );
            written += 1;
        }
        return written;
    } catch (err) {
        log.error('Error upserting recommendations', { tenantId, error: String(err) });
        throw err;
    } finally {
        client.release();
    }
}

export async function createRun(tenantId: string, trigger: string, lookbackDays: number): Promise<string> {
    const client: PoolClient = await getPool().connect();
    try {
        const r = await client.query(
            `INSERT INTO right_sizing_runs (id, "tenantId", status, trigger, "lookbackDays", "startedAt")
             VALUES (gen_random_uuid()::text, $1, 'running', $2, $3, now()) RETURNING id`,
            [tenantId, trigger, lookbackDays]
        );
        return r.rows[0].id;
    } finally {
        client.release();
    }
}

export async function finishRun(
    id: string,
    tenantId: string,
    fields: {
        status: string;
        accountsScanned: number;
        resourcesAnalyzed: number;
        recommendationsGenerated: number;
        totalEstimatedSavings: number;
        errors: unknown[];
    }
): Promise<void> {
    const client: PoolClient = await getPool().connect();
    try {
        await client.query(
            `UPDATE right_sizing_runs
             SET status = $3, "accountsScanned" = $4, "resourcesAnalyzed" = $5,
                 "recommendationsGenerated" = $6, "totalEstimatedSavings" = $7, errors = $8::jsonb, "finishedAt" = now()
             WHERE id = $1 AND "tenantId" = $2`,
            [
                id, tenantId, fields.status, fields.accountsScanned, fields.resourcesAnalyzed,
                fields.recommendationsGenerated, fields.totalEstimatedSavings, JSON.stringify(fields.errors),
            ]
        );
    } finally {
        client.release();
    }
}

export type RightSizingPeriod = 'daily' | 'weekly' | 'monthly';
const CONFIG_KEY = 'right-sizing-cron';

/** Read the tenant's right-sizing cadence config (defaults to weekly). */
export async function getTenantPeriodConfig(
    tenantId: string
): Promise<{ period: RightSizingPeriod; lastRunAt: string | null }> {
    const client: PoolClient = await getPool().connect();
    try {
        const r = await client.query(
            `SELECT data FROM tenant_configs WHERE "tenantId" = $1 AND "configKey" = $2 LIMIT 1`,
            [tenantId, CONFIG_KEY]
        );
        const data = (r.rows[0]?.data ?? {}) as { period?: string; lastRunAt?: string };
        const valid: RightSizingPeriod[] = ['daily', 'weekly', 'monthly'];
        const period = (valid.includes(data.period as RightSizingPeriod) ? data.period : 'weekly') as RightSizingPeriod;
        return { period, lastRunAt: data.lastRunAt ?? null };
    } finally {
        client.release();
    }
}

export async function updateLastRun(tenantId: string, lastRunAt: string): Promise<void> {
    const client: PoolClient = await getPool().connect();
    try {
        await client.query(
            `INSERT INTO tenant_configs ("id","tenantId","configKey",data,"updatedAt","updatedBy")
             VALUES (gen_random_uuid()::text, $1, $2, $3::jsonb, now(), 'worker')
             ON CONFLICT ("tenantId","configKey")
             DO UPDATE SET data = tenant_configs.data || $3::jsonb, "updatedAt" = now()`,
            [tenantId, CONFIG_KEY, JSON.stringify({ lastRunAt })]
        );
    } finally {
        client.release();
    }
}

export async function hasActiveRun(tenantId: string): Promise<boolean> {
    const client: PoolClient = await getPool().connect();
    try {
        const r = await client.query(
            `SELECT 1 FROM right_sizing_runs WHERE "tenantId" = $1 AND status IN ('queued','running') LIMIT 1`,
            [tenantId]
        );
        return (r.rowCount ?? 0) > 0;
    } finally {
        client.release();
    }
}
