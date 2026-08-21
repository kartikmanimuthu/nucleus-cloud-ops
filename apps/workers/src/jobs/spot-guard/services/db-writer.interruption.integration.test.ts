// workers/src/jobs/spot-guard/services/db-writer.interruption.integration.test.ts
//
//   docker compose up -d postgres
//   cd apps/workers && bun run test -- db-writer.interruption.integration
//
// recordInterruption is an UPDATE ... RETURNING against a multi-tenant table, and the handler tests
// mock it out entirely, so its SQL had nowhere to be checked. Three things about it can only be
// verified against a real database: that the increment is an increment rather than a write of 1,
// that it returns null instead of throwing when the row does not exist yet, and that it cannot
// touch another tenant's row for the same AWS service.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getPool } from '../../discovery/services/db.js';
import { recordInterruption } from './db-writer.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);

const A = 'test-sg-int-tenant-a';
const B = 'test-sg-int-tenant-b';
const ACCOUNT = '333333333333';
const REGION = 'ap-south-1';
const CLUSTER = 'int-cluster';
const SERVICE = 'int-api';

const target = (tenantId: string) => ({
    tenantId,
    accountId: ACCOUNT,
    region: REGION,
    clusterName: CLUSTER,
    serviceName: SERVICE,
});

async function seedService(tenantId: string, interruptionCount = 0) {
    await getPool().query(
        `INSERT INTO spot_guard_services
           (id, "tenantId", "accountId", region, "clusterName", "serviceName",
            "capacityState", "managementState", "interruptionCount", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, 'spot', 'managed', $7, now())`,
        [`svc-${tenantId}`, tenantId, ACCOUNT, REGION, CLUSTER, SERVICE, interruptionCount],
    );
}

async function counts(tenantId: string) {
    const { rows } = await getPool().query(
        `SELECT "interruptionCount", "lastEventAt" FROM spot_guard_services WHERE "tenantId" = $1`,
        [tenantId],
    );
    return rows[0];
}

async function wipe() {
    await getPool().query('DELETE FROM spot_guard_services WHERE "tenantId" = ANY($1)', [[A, B]]);
}

describe.skipIf(!HAS_DB)('recordInterruption (real Postgres)', () => {
    beforeAll(async () => {
        await getPool().query('SELECT 1');
    });

    afterAll(async () => {
        await wipe();
        // Deliberately NOT closePool(). getPool() is a module singleton and several integration
        // files can land in one vitest worker, so ending the pool here yanks it out from under a
        // file that is still running — which is exactly what happened when this file was added as
        // the fifth such suite. Vitest tears the worker down regardless.
    });

    beforeEach(wipe);

    it('increments rather than overwriting', async () => {
        await seedService(A, 11);

        const id = await recordInterruption(target(A));

        expect(id).toBe(`svc-${A}`);
        // 12, not 1 — the console card showed 12 real interruptions while the column said 0.
        expect((await counts(A)).interruptionCount).toBe(12);
    });

    it('accumulates across calls', async () => {
        await seedService(A);
        await recordInterruption(target(A));
        await recordInterruption(target(A));
        await recordInterruption(target(A));
        expect((await counts(A)).interruptionCount).toBe(3);
    });

    it('stamps lastEventAt, so the console shows the reclaim as recent activity', async () => {
        await seedService(A);
        expect((await counts(A)).lastEventAt).toBeNull();

        await recordInterruption(target(A));

        expect((await counts(A)).lastEventAt).not.toBeNull();
    });

    it('returns null for a service with no registry row instead of throwing', async () => {
        // The first ever sighting: handleTaskStateChange creates the row moments later. This runs
        // on the high-volume event path, so it must not create rows or fail.
        await expect(recordInterruption(target(A))).resolves.toBeNull();
    });

    it('never touches another tenant\'s row for the same AWS service', async () => {
        // Two tenants can both onboard one AWS account, so this exact collision is expected.
        await seedService(A, 5);
        await seedService(B, 5);

        await recordInterruption(target(A));

        expect((await counts(A)).interruptionCount).toBe(6);
        expect((await counts(B)).interruptionCount).toBe(5);
    });

    it('does not match a different service in the same cluster', async () => {
        await seedService(A, 7);

        const id = await recordInterruption({ ...target(A), serviceName: 'some-other-api' });

        expect(id).toBeNull();
        expect((await counts(A)).interruptionCount).toBe(7);
    });
});
