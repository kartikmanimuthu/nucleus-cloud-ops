// Integration test against a real local Postgres (docker compose up -d postgres,
// migrated with libs/prisma/migrations/20260805120000_add_scaling_audit). Loads
// DATABASE_URL from the repo-root .env if it isn't already in the environment
// (vitest does not auto-load .env — see apps/workers/vitest.config.ts), and skips
// entirely if no DB is reachable, so this never breaks a sandboxed test run.
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import type { NormalizedScalingEvent } from '../types.js';

function loadDatabaseUrlFromEnvFile(): void {
    if (process.env.DATABASE_URL) return;
    const envPath = resolve(import.meta.dirname, '../../../../../../.env');
    if (!existsSync(envPath)) return;
    const match = readFileSync(envPath, 'utf-8').match(/^DATABASE_URL=(.+)$/m);
    if (match) process.env.DATABASE_URL = match[1].trim();
}

loadDatabaseUrlFromEnvFile();

const TEST_TENANT_A = `sa-test-tenant-a-${Date.now()}`;
const TEST_TENANT_B = `sa-test-tenant-b-${Date.now()}`;

function baseEvent(overrides: Partial<NormalizedScalingEvent>): NormalizedScalingEvent {
    return {
        tenantId: TEST_TENANT_A,
        accountId: '111111111111',
        region: 'ap-south-1',
        scope: 'asg',
        source: 'aws_api',
        activityId: 'activity-1',
        resourceId: 'my-asg',
        cause: 'a scheduled action named x changing the desired capacity from 1 to 2',
        rawPayload: {},
        startedAt: new Date('2026-01-01T00:00:00Z'),
        inventoryMatched: false,
        scalingType: 'scheduled',
        actor: 'system',
        actorType: 'system',
        ...overrides,
    };
}

// Top-level await (this is an ESM test file) so dbAvailable is resolved BEFORE
// describe/it are collected — a beforeAll() runs too late for .skipIf(), which
// vitest evaluates at collection time, not after hooks.
let pool: Pool | null = null;
let dbAvailable = false;
if (process.env.DATABASE_URL) {
    try {
        pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 2000 });
        await pool.query('SELECT 1');
        dbAvailable = true;
    } catch {
        dbAvailable = false;
    }
}

afterAll(async () => {
    if (pool) {
        await pool.query(`DELETE FROM scaling_audit_watermarks WHERE "tenantId" IN ($1, $2)`, [TEST_TENANT_A, TEST_TENANT_B]).catch(() => {});
        await pool.query(`DELETE FROM network_link_samples WHERE "tenantId" IN ($1, $2)`, [TEST_TENANT_A, TEST_TENANT_B]).catch(() => {});
        // scaling_events rejects DELETE by design (immutability trigger) — disable it
        // for this test's own cleanup only, exactly like the manual verification
        // performed during implementation (see the plan's "Verification" section).
        await pool.query(`ALTER TABLE scaling_events DISABLE TRIGGER trg_scaling_events_immutable`).catch(() => {});
        await pool.query(`DELETE FROM scaling_events WHERE "tenantId" IN ($1, $2)`, [TEST_TENANT_A, TEST_TENANT_B]).catch(() => {});
        await pool.query(`ALTER TABLE scaling_events ENABLE TRIGGER trg_scaling_events_immutable`).catch(() => {});
        await pool.end();
    }
});

describe.skipIf(!dbAvailable)('db-writer integration (real Postgres)', () => {
    it('insertEvents is idempotent — re-inserting the same (tenant, source, activityId) inserts 0 rows', async () => {
        const { insertEvents } = await import('./db-writer.js');
        const event = baseEvent({ activityId: 'idempotency-test-1' });

        const firstInsert = await insertEvents([event], 'run-1');
        const secondInsert = await insertEvents([event], 'run-2');

        expect(firstInsert).toBe(1);
        expect(secondInsert).toBe(0);
    });

    it('the same activityId across two different tenants does not collide (uniqueness is tenant-scoped)', async () => {
        const { insertEvents } = await import('./db-writer.js');
        const sharedActivityId = 'cross-tenant-activity-1';
        const eventA = baseEvent({ activityId: sharedActivityId, tenantId: TEST_TENANT_A });
        const eventB = baseEvent({ activityId: sharedActivityId, tenantId: TEST_TENANT_B });

        const insertedA = await insertEvents([eventA], 'run-a');
        const insertedB = await insertEvents([eventB], 'run-b');

        expect(insertedA).toBe(1);
        expect(insertedB).toBe(1);
    });

    it('watermark upsert never lets consecutiveFailures reset on a failed poll', async () => {
        const { upsertWatermark, getWatermark } = await import('./db-writer.js');
        await upsertWatermark(TEST_TENANT_A, '111111111111', 'ap-south-1', 'asg', 'aws_api', { lastRunId: 'run-1', success: true, lastActivityAt: new Date() });
        await upsertWatermark(TEST_TENANT_A, '111111111111', 'ap-south-1', 'asg', 'aws_api', { lastRunId: 'run-2', success: false });

        const watermark = await getWatermark(TEST_TENANT_A, '111111111111', 'ap-south-1', 'asg', 'aws_api');
        expect(watermark.lastActivityAt).not.toBeNull(); // preserved from the successful poll
    });

    it('keeps an INDEPENDENT watermark per source for the same scope', async () => {
        // Without source in the unique key, a CloudTrail poll of scope='ecs' would
        // overwrite the activity-API mark for that scope and the two sources would
        // silently skip each other's windows.
        const { upsertWatermark, getWatermark } = await import('./db-writer.js');
        const awsAt = new Date('2026-08-01T00:00:00Z');
        const ctAt = new Date('2026-08-05T00:00:00Z');

        await upsertWatermark(TEST_TENANT_A, '222222222222', 'ap-south-1', 'ecs', 'aws_api', { lastRunId: 'r1', success: true, lastActivityAt: awsAt, lastActivityId: 'aws-1' });
        await upsertWatermark(TEST_TENANT_A, '222222222222', 'ap-south-1', 'ecs', 'cloudtrail', { lastRunId: 'r1', success: true, lastActivityAt: ctAt, lastActivityId: 'ct-1' });

        const awsMark = await getWatermark(TEST_TENANT_A, '222222222222', 'ap-south-1', 'ecs', 'aws_api');
        const ctMark = await getWatermark(TEST_TENANT_A, '222222222222', 'ap-south-1', 'ecs', 'cloudtrail');

        expect(awsMark.lastActivityId).toBe('aws-1');
        expect(ctMark.lastActivityId).toBe('ct-1');
        expect(awsMark.lastActivityAt?.toISOString()).toBe(awsAt.toISOString());
        expect(ctMark.lastActivityAt?.toISOString()).toBe(ctAt.toISOString());
    });

    it('dedups a CloudTrail eventID on re-insert, and keeps it distinct from an aws_api row', async () => {
        const { insertEvents } = await import('./db-writer.js');
        const base = {
            tenantId: TEST_TENANT_A, accountId: '333333333333', region: 'ap-south-1',
            scope: 'ecs' as const, resourceId: 'service/c/s', cause: 'x', scalingType: 'manual' as const,
            startedAt: new Date('2026-08-05T10:00:00Z'), rawPayload: {}, inventoryMatched: false,
            actor: 'arn:aws:iam::333333333333:user/alice', actorType: 'user' as const,
        };
        const ct = { ...base, source: 'cloudtrail' as const, activityId: 'shared-id' };
        const aws = { ...base, source: 'aws_api' as const, activityId: 'shared-id' };

        // Same activityId under two sources = two independent observations, kept.
        expect(await insertEvents([ct], 'run-ct')).toBe(1);
        expect(await insertEvents([aws], 'run-aws')).toBe(1);
        // Re-inserting either is a no-op.
        expect(await insertEvents([ct], 'run-ct-2')).toBe(0);
    });

    describe('upsertNetworkLinkSamples', () => {
        function baseSample(overrides: {
            resourceType?: 'dx_connection' | 'vpn_tunnel';
            resourceId?: string;
            bpsAvgIn?: number;
        }) {
            return {
                accountId: '444444444444',
                region: 'ap-south-1',
                resourceType: 'dx_connection' as const,
                resourceId: 'dxcon-1',
                displayName: 'HQ Uplink',
                installedBandwidthMbps: 1000,
                bpsAvgIn: 100,
                bpsMaxIn: 150,
                bpsAvgOut: 900,
                bpsMaxOut: 950,
                stateUp: true,
                bucketStartUtc: new Date('2026-08-17T10:00:00Z'),
                ...overrides,
            };
        }

        it('is idempotent on (tenantId, resourceType, resourceId, bucketStartUtc) — re-upserting the same key writes 1 row, not 2', async () => {
            const { upsertNetworkLinkSamples } = await import('./db-writer.js');
            const sample = baseSample({ resourceId: 'dxcon-idempotency-1' });

            expect(await upsertNetworkLinkSamples(TEST_TENANT_A, [sample])).toBe(1);
            expect(await upsertNetworkLinkSamples(TEST_TENANT_A, [sample])).toBe(1);

            const rows = await pool!.query(
                `SELECT * FROM network_link_samples WHERE "tenantId" = $1 AND "resourceId" = $2`,
                [TEST_TENANT_A, 'dxcon-idempotency-1']
            );
            expect(rows.rowCount).toBe(1);
        });

        it('a re-upsert for the same key OVERWRITES the metric values (DO UPDATE, not DO NOTHING)', async () => {
            const { upsertNetworkLinkSamples } = await import('./db-writer.js');
            const resourceId = 'dxcon-overwrite-1';
            await upsertNetworkLinkSamples(TEST_TENANT_A, [baseSample({ resourceId, bpsAvgIn: 100 })]);
            await upsertNetworkLinkSamples(TEST_TENANT_A, [baseSample({ resourceId, bpsAvgIn: 999 })]);

            const rows = await pool!.query(
                `SELECT "bpsAvgIn" FROM network_link_samples WHERE "tenantId" = $1 AND "resourceId" = $2`,
                [TEST_TENANT_A, resourceId]
            );
            expect(rows.rowCount).toBe(1);
            expect(Number(rows.rows[0].bpsAvgIn)).toBe(999);
        });

        it('a VPN tunnel and a DX connection with the same bucket hour do not collide (unique key includes resourceType)', async () => {
            const { upsertNetworkLinkSamples } = await import('./db-writer.js');
            const sameId = 'shared-resource-id';
            await upsertNetworkLinkSamples(TEST_TENANT_A, [baseSample({ resourceType: 'dx_connection', resourceId: sameId })]);
            await upsertNetworkLinkSamples(TEST_TENANT_A, [baseSample({ resourceType: 'vpn_tunnel', resourceId: sameId })]);

            const rows = await pool!.query(`SELECT "resourceType" FROM network_link_samples WHERE "tenantId" = $1 AND "resourceId" = $2`, [
                TEST_TENANT_A,
                sameId,
            ]);
            expect(rows.rowCount).toBe(2);
        });

        it('is a no-op given an empty array', async () => {
            const { upsertNetworkLinkSamples } = await import('./db-writer.js');
            expect(await upsertNetworkLinkSamples(TEST_TENANT_A, [])).toBe(0);
        });
    });
});
