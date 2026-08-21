// workers/src/jobs/capacity-planning/services/db-writer.ts
//
// Raw-pg persistence for the capacity-planning worker (SA-004), same split as
// scaling-audit/services/db-writer.ts: raw SQL is NOT intercepted by the
// tenant extension, every query here scopes tenantId manually.
import type { PoolClient } from 'pg';
import { getPool } from '../../discovery/services/db.js';
import { createLogger } from '../../../lib/logger.js';
import type { CapacitySample, CapacityResourceType, ResourceToScan } from '../types.js';

const log = createLogger('capacity-planning-db-writer');

/** arn:aws:ecs:<region>:<account>:service/<cluster>/<service> — the format
 *  discovery stores for ecs_services (see scaling-audit/services/normalize.ts,
 *  which documents the same ARN shape for the identical reason). */
const ECS_SERVICE_ARN = /^arn:[^:]*:ecs:[^:]*:[^:]*:service\/([^/]+)\/(.+)$/;

export function parseEcsServiceArn(resourceId: string): { clusterName: string; serviceName: string } | null {
    const match = resourceId.match(ECS_SERVICE_ARN);
    return match ? { clusterName: match[1], serviceName: match[2] } : null;
}

// ── Resources to scan ────────────────────────────────────────────────────────

export async function getEcsServicesToScan(tenantId: string, accountId: string): Promise<ResourceToScan[]> {
    const client: PoolClient = await getPool().connect();
    try {
        const result = await client.query(
            `SELECT "resourceId", metadata->>'taskDefinition' AS "taskDefinitionArn"
             FROM inventory_resources
             WHERE "tenantId" = $1 AND "accountId" = $2 AND "resourceType" = 'ecs_services' AND "isCurrent" = true`,
            [tenantId, accountId]
        );
        const resources: ResourceToScan[] = [];
        for (const row of result.rows) {
            const parsed = parseEcsServiceArn(row.resourceId as string);
            if (!parsed) {
                log.warn('ECS service resourceId did not match the expected ARN shape — skipped', { resourceId: row.resourceId });
                continue;
            }
            resources.push({
                resourceType: 'ecs',
                resourceId: row.resourceId,
                clusterName: parsed.clusterName,
                serviceName: parsed.serviceName,
                taskDefinitionArn: row.taskDefinitionArn ?? undefined,
            });
        }
        return resources;
    } finally {
        client.release();
    }
}

export async function getAsgsToScan(tenantId: string, accountId: string): Promise<ResourceToScan[]> {
    const client: PoolClient = await getPool().connect();
    try {
        const result = await client.query(
            `SELECT "resourceId" FROM inventory_resources
             WHERE "tenantId" = $1 AND "accountId" = $2 AND "resourceType" = 'autoscaling_auto_scaling_groups' AND "isCurrent" = true`,
            [tenantId, accountId]
        );
        // ASG resourceId is already the bare group name — no ARN to parse.
        return result.rows.map((row) => ({ resourceType: 'asg' as const, resourceId: row.resourceId, asgName: row.resourceId }));
    } finally {
        client.release();
    }
}

// ── Watermark — MAX(bucketStartUtc) IS the watermark, no separate table ────

/** Where this resource's polling left off, or null if it has never been
 *  sampled (first-run backfill applies). */
export async function getLastBucket(tenantId: string, resourceType: CapacityResourceType, resourceId: string): Promise<Date | null> {
    const client: PoolClient = await getPool().connect();
    try {
        const result = await client.query(
            `SELECT MAX("bucketStartUtc") AS "lastBucket" FROM capacity_utilization_samples
             WHERE "tenantId" = $1 AND "resourceType" = $2 AND "resourceId" = $3`,
            [tenantId, resourceType, resourceId]
        );
        return result.rows[0]?.lastBucket ?? null;
    } finally {
        client.release();
    }
}

// ── Samples ──────────────────────────────────────────────────────────────────

/** Upsert — DO UPDATE (not DO NOTHING) because the overlap window (see config's
 *  watermarkOverlapHours) deliberately re-fetches the last couple of hours in
 *  case the most recent bucket was still incomplete at the previous poll. */
export async function upsertSamples(samples: CapacitySample[], runId: string): Promise<number> {
    if (!samples.length) return 0;
    const client: PoolClient = await getPool().connect();
    try {
        let written = 0;
        for (const s of samples) {
            const result = await client.query(
                `INSERT INTO capacity_utilization_samples
                    (id, "tenantId", "accountId", region, "resourceType", "resourceId",
                     "clusterName", "serviceName", "asgName", "bucketStartUtc",
                     "cpuAvg", "cpuMax", "memAvg", "memMax", "installedVcpu", "installedMemGiB",
                     "capturedByRunId")
                 VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
                 ON CONFLICT ("tenantId", "resourceType", "resourceId", "bucketStartUtc") DO UPDATE SET
                    "cpuAvg" = EXCLUDED."cpuAvg", "cpuMax" = EXCLUDED."cpuMax",
                    "memAvg" = EXCLUDED."memAvg", "memMax" = EXCLUDED."memMax",
                    "installedVcpu" = EXCLUDED."installedVcpu", "installedMemGiB" = EXCLUDED."installedMemGiB",
                    "capturedByRunId" = EXCLUDED."capturedByRunId", "capturedAt" = now()`,
                [
                    s.tenantId, s.accountId, s.region, s.resourceType, s.resourceId,
                    s.clusterName ?? null, s.serviceName ?? null, s.asgName ?? null, s.bucketStartUtc,
                    s.cpuAvg ?? null, s.cpuMax ?? null, s.memAvg ?? null, s.memMax ?? null,
                    s.installedVcpu ?? null, s.installedMemGiB ?? null,
                    runId,
                ]
            );
            written += result.rowCount ?? 0;
        }
        return written;
    } catch (err) {
        log.error('Error upserting capacity samples', { runId, error: err instanceof Error ? err.message : String(err) });
        throw err;
    } finally {
        client.release();
    }
}

// ── Runs ───────────────────────────────────────────────────────────────────────

export async function createRun(tenantId: string, trigger: 'schedule' | 'manual'): Promise<string> {
    const client: PoolClient = await getPool().connect();
    try {
        const r = await client.query(
            `INSERT INTO capacity_planning_runs (id, "tenantId", status, trigger, "startedAt")
             VALUES (gen_random_uuid()::text, $1, 'running', $2, now()) RETURNING id`,
            [tenantId, trigger]
        );
        return r.rows[0].id;
    } finally {
        client.release();
    }
}

export async function finishRun(
    runId: string,
    tenantId: string,
    fields: { status: 'completed' | 'failed'; accountsScanned: number; resourcesScanned: number; samplesWritten: number; errors: unknown[] }
): Promise<void> {
    const client: PoolClient = await getPool().connect();
    try {
        await client.query(
            `UPDATE capacity_planning_runs SET
                status = $3, "accountsScanned" = $4, "resourcesScanned" = $5, "samplesWritten" = $6,
                errors = $7::jsonb, "finishedAt" = now()
             WHERE id = $1 AND "tenantId" = $2`,
            [runId, tenantId, fields.status, fields.accountsScanned, fields.resourcesScanned, fields.samplesWritten, JSON.stringify(fields.errors)]
        );
    } finally {
        client.release();
    }
}

export async function hasActiveRun(tenantId: string): Promise<boolean> {
    const client: PoolClient = await getPool().connect();
    try {
        const r = await client.query(
            `SELECT 1 FROM capacity_planning_runs WHERE "tenantId" = $1 AND status IN ('queued', 'running') LIMIT 1`,
            [tenantId]
        );
        return (r.rowCount ?? 0) > 0;
    } finally {
        client.release();
    }
}
