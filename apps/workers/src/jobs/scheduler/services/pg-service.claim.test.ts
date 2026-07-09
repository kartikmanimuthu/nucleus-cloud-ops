// Integration test for the atomic per-tenant claim — the single most
// safety-critical query in the worker (its concurrency guarantee is what makes
// >1 replica safe for AWS-mutating scans). Unit tests elsewhere MOCK
// tryClaimTenantRun; this exercises the real SQL against a real Postgres.
//
// Gated on TEST_DATABASE_URL so it runs in CI when a throwaway DB is provisioned
// and skips (does not fail) locally / where no DB is available.
//   TEST_DATABASE_URL=postgres://... bunx vitest run pg-service.claim.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';

const TEST_DB = process.env.TEST_DATABASE_URL;
const suite = TEST_DB ? describe : describe.skip;

const KEY = 'scheduler-cron';
const HOUR_MS = 60 * 60 * 1000;

suite('tryClaimTenantRun (integration — needs TEST_DATABASE_URL)', () => {
    let pool: Pool;
    let tryClaimTenantRun: typeof import('./pg-service.js').tryClaimTenantRun;

    beforeAll(async () => {
        // pg-service captures env.DATABASE_URL at import — set it before importing.
        process.env.DATABASE_URL = TEST_DB;
        ({ tryClaimTenantRun } = await import('./pg-service.js'));

        pool = new Pool({ connectionString: TEST_DB });
        await pool.query(`
            CREATE TABLE IF NOT EXISTS tenant_configs (
                id text PRIMARY KEY,
                "tenantId" text NOT NULL,
                "configKey" text NOT NULL,
                data jsonb NOT NULL DEFAULT '{}',
                "updatedAt" timestamptz NOT NULL DEFAULT now(),
                "updatedBy" text,
                UNIQUE ("tenantId", "configKey")
            )`);
    });

    afterAll(async () => {
        await pool?.query(`DELETE FROM tenant_configs WHERE "tenantId" LIKE 'claim-test-%'`).catch(() => {});
        await pool?.end();
    });

    beforeEach(async () => {
        await pool.query(`DELETE FROM tenant_configs WHERE "tenantId" LIKE 'claim-test-%'`);
    });

    it('grants the first-ever claim (no row yet)', async () => {
        expect(await tryClaimTenantRun('claim-test-1', KEY, HOUR_MS)).toBe(true);
    });

    it('denies a second claim inside the interval', async () => {
        expect(await tryClaimTenantRun('claim-test-2', KEY, HOUR_MS)).toBe(true);
        expect(await tryClaimTenantRun('claim-test-2', KEY, HOUR_MS)).toBe(false);
    });

    it('grants again once the interval has elapsed', async () => {
        expect(await tryClaimTenantRun('claim-test-3', KEY, HOUR_MS)).toBe(true);
        await pool.query(
            `UPDATE tenant_configs SET data = jsonb_build_object('lastRunAt', $2::text)
             WHERE "tenantId" = $1 AND "configKey" = $3`,
            ['claim-test-3', new Date(Date.now() - 2 * HOUR_MS).toISOString(), KEY],
        );
        expect(await tryClaimTenantRun('claim-test-3', KEY, HOUR_MS)).toBe(true);
    });

    it('grants EXACTLY ONE of N concurrent claims (the race guarantee)', async () => {
        const results = await Promise.all(
            Array.from({ length: 8 }, () => tryClaimTenantRun('claim-test-4', KEY, HOUR_MS)),
        );
        expect(results.filter(Boolean).length).toBe(1);
    });

    it('self-heals a corrupt (non-ISO) lastRunAt by treating it as claimable', async () => {
        await pool.query(
            `INSERT INTO tenant_configs (id, "tenantId", "configKey", data)
             VALUES (gen_random_uuid()::text, $1, $2, jsonb_build_object('lastRunAt', 'not-a-timestamp'))`,
            ['claim-test-5', KEY],
        );
        // Must not throw (the CASE guard prevents the ::timestamptz cast) and must claim.
        expect(await tryClaimTenantRun('claim-test-5', KEY, HOUR_MS)).toBe(true);
    });
});
