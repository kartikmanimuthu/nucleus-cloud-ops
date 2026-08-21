// workers/src/jobs/spot-guard/services/db-writer.applied-strategy.test.ts
//
// Its own file because it needs the pg pool mocked, while db-writer.test.ts is deliberately
// mock-free pure-function cover and db-writer.integration.test.ts needs a real Postgres (skipped
// in CI). Same split as engine.test.ts / engine.property.test.ts / engine.vectors.test.ts.
//
// The contract under test is the one that cannot be checked from the handler side, because the
// handler tests mock this function out: recordAppliedStrategy must NEVER be the reason a safety
// mutation is left half-recorded. Both callers run it AFTER UpdateService has already changed the
// customer's service — if it threw, the restore path would skip recordRestoreSuccess (leaving the
// restore debt uncleared) and the fallback path would stop notifying the remaining tenants
// mid-loop.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CapacityProviderStrategyItem } from '../types.js';

const { connect, query, release } = vi.hoisted(() => ({
    connect: vi.fn(),
    query: vi.fn(),
    release: vi.fn(),
}));

vi.mock('../../discovery/services/db.js', () => ({ getPool: () => ({ connect }) }));

const { recordAppliedStrategy } = await import('./db-writer.js');

const STRATEGY: CapacityProviderStrategyItem[] = [
    { capacityProvider: 'FARGATE_SPOT', weight: 30, base: 0 },
    { capacityProvider: 'FARGATE', weight: 70, base: 0 },
];

const call = () => recordAppliedStrategy({ tenantId: 't1', serviceId: 'svc-1', appliedStrategy: STRATEGY });

beforeEach(() => {
    vi.clearAllMocks();
    connect.mockResolvedValue({ query, release });
    query.mockResolvedValue({ rows: [] });
});

describe('recordAppliedStrategy', () => {
    it('persists the strategy and stamps observedAt', async () => {
        await call();

        const [sql, params] = query.mock.calls[0];
        expect(sql).toContain('"observedStrategy" = $3::jsonb');
        expect(sql).toContain('"observedAt"');
        expect(JSON.parse(params[2] as string)).toEqual(STRATEGY);
    });

    it('scopes the update by tenant AND id — never id alone', async () => {
        // spot_guard_services is multi-tenant: several tenants can hold a row for the same AWS
        // service, and one tenant's action must not rewrite another's row.
        await call();

        const [sql, params] = query.mock.calls[0];
        expect(sql).toContain('WHERE "tenantId" = $1 AND id = $2');
        expect(params[0]).toBe('t1');
        expect(params[1]).toBe('svc-1');
    });

    it('does NOT write capacityState — that column belongs to the task observer', async () => {
        // Changing a capacity provider strategy does not move already-running tasks, so they may
        // still be on the old provider. Setting it here would make the Capacity column lie.
        await call();
        expect(query.mock.calls[0][0]).not.toContain('capacityState');
    });

    describe('best effort', () => {
        it('resolves instead of throwing when the UPDATE fails', async () => {
            query.mockRejectedValueOnce(new Error('deadlock detected'));
            await expect(call()).resolves.toBeUndefined();
        });

        it('resolves when the pool cannot even hand out a connection', async () => {
            connect.mockRejectedValueOnce(new Error('too many clients already'));
            await expect(call()).resolves.toBeUndefined();
        });

        it('still releases the connection when the UPDATE fails', async () => {
            // Leaking a pooled client here would be a worse bug than the stale column it fixes.
            query.mockRejectedValueOnce(new Error('deadlock detected'));
            await call();
            expect(release).toHaveBeenCalledTimes(1);
        });
    });
});
