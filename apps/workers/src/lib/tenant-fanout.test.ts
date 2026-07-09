import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../jobs/scheduler/services/pg-service.js', () => ({
    tryClaimTenantRun: vi.fn(),
    releaseTenantJobClaim: vi.fn().mockResolvedValue(undefined),
}));

import { ensureStatelyScanQueue, dispatchTenantScan, DEAD_LETTER_QUEUE } from './tenant-fanout.js';
import { tryClaimTenantRun, releaseTenantJobClaim } from '../jobs/scheduler/services/pg-service.js';

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function makeBoss(overrides: Record<string, unknown> = {}) {
    const executeSql = vi.fn().mockResolvedValue(undefined);
    return {
        boss: {
            getQueue: vi.fn().mockResolvedValue(null),
            createQueue: vi.fn().mockResolvedValue(undefined),
            updateQueue: vi.fn().mockResolvedValue(undefined),
            send: vi.fn().mockResolvedValue('job-1'),
            getDb: vi.fn().mockReturnValue({ executeSql }),
            ...overrides,
        } as any,
        executeSql,
    };
}

describe('ensureStatelyScanQueue', () => {
    beforeEach(() => vi.clearAllMocks());

    it('creates a fresh stately queue with dead-letter + no migration', async () => {
        const { boss, executeSql } = makeBoss({ getQueue: vi.fn().mockResolvedValue(null) });
        await ensureStatelyScanQueue(boss, 'q', log, { expireInSeconds: 900, retryLimit: 0 });
        expect(boss.createQueue).toHaveBeenCalledWith('q', expect.objectContaining({
            policy: 'stately', retryLimit: 0, expireInSeconds: 900, deadLetter: DEAD_LETTER_QUEUE,
        }));
        expect(executeSql).not.toHaveBeenCalled();
    });

    it('migrates + purges a legacy standard queue', async () => {
        const { boss, executeSql } = makeBoss({
            getQueue: vi.fn().mockResolvedValue({ name: 'q', policy: 'standard' }),
        });
        await ensureStatelyScanQueue(boss, 'q', log, { expireInSeconds: 900 });
        expect(executeSql).toHaveBeenCalledWith(expect.stringMatching(/DELETE FROM pgboss\.job/), ['q']);
        expect(executeSql).toHaveBeenCalledWith(expect.stringMatching(/UPDATE pgboss\.queue SET policy = 'stately'/), ['q']);
    });

    it('does not migrate an already-stately queue', async () => {
        const { boss, executeSql } = makeBoss({
            getQueue: vi.fn().mockResolvedValue({ name: 'q', policy: 'stately' }),
        });
        await ensureStatelyScanQueue(boss, 'q', log, { expireInSeconds: 900 });
        expect(executeSql).not.toHaveBeenCalled();
        expect(boss.updateQueue).toHaveBeenCalledWith('q', expect.objectContaining({ expireInSeconds: 900 }));
    });
});

describe('dispatchTenantScan', () => {
    beforeEach(() => vi.clearAllMocks());

    const base = {
        scanQueue: 'discovery-scan',
        tenantId: 'ten-1',
        jobType: 'discovery-cron',
        minIntervalMs: 86_400_000,
        payload: { tenantId: 'ten-1' },
        log,
    };

    it('returns skipped-interval and does not send when the claim is denied', async () => {
        vi.mocked(tryClaimTenantRun).mockResolvedValue(false);
        const { boss } = makeBoss();
        const outcome = await dispatchTenantScan({ boss, ...base });
        expect(outcome).toBe('skipped-interval');
        expect(boss.send).not.toHaveBeenCalled();
    });

    it('dispatches with a per-tenant singletonKey when the claim is granted', async () => {
        vi.mocked(tryClaimTenantRun).mockResolvedValue(true);
        const { boss } = makeBoss();
        const outcome = await dispatchTenantScan({ boss, ...base, sendOptions: { retryLimit: 2 } });
        expect(outcome).toBe('dispatched');
        expect(boss.send).toHaveBeenCalledWith('discovery-scan', base.payload,
            expect.objectContaining({ singletonKey: 'tenant:ten-1', retryLimit: 2 }));
    });

    it('returns skipped-duplicate (no release) when send returns null', async () => {
        vi.mocked(tryClaimTenantRun).mockResolvedValue(true);
        const { boss } = makeBoss({ send: vi.fn().mockResolvedValue(null) });
        const outcome = await dispatchTenantScan({ boss, ...base });
        expect(outcome).toBe('skipped-duplicate');
        expect(releaseTenantJobClaim).not.toHaveBeenCalled();
    });

    it('releases the claim and returns failed when send throws', async () => {
        vi.mocked(tryClaimTenantRun).mockResolvedValue(true);
        const { boss } = makeBoss({ send: vi.fn().mockRejectedValue(new Error('boom')) });
        const outcome = await dispatchTenantScan({ boss, ...base });
        expect(outcome).toBe('failed');
        expect(releaseTenantJobClaim).toHaveBeenCalledWith('ten-1', 'discovery-cron', 86_400_000);
    });
});
