import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockStart, mockCreateQueue, mockOn, instances, PgBossMock } = vi.hoisted(() => {
    const mockStart = vi.fn().mockResolvedValue(undefined);
    const mockCreateQueue = vi.fn().mockResolvedValue(undefined);
    const mockOn = vi.fn();
    const instances: any[] = [];
    class PgBossMock {
        start = mockStart;
        createQueue = mockCreateQueue;
        on = mockOn;
        opts: unknown;
        constructor(opts: unknown) {
            this.opts = opts;
            instances.push(this);
        }
    }
    return { mockStart, mockCreateQueue, mockOn, instances, PgBossMock };
});

vi.mock('pg-boss', () => ({ default: PgBossMock }));
vi.mock('@/env', () => ({ env: { DATABASE_URL: 'postgres://test/db' } }));

import { env } from '@/env';

beforeEach(() => {
    vi.clearAllMocks();
    instances.length = 0;
    mockStart.mockResolvedValue(undefined);
    mockCreateQueue.mockResolvedValue(undefined);
    (env as any).DATABASE_URL = 'postgres://test/db';
});

// The client caches its pg-boss instance in a module-scoped `let`. Each test needs a
// pristine singleton, so re-import a fresh module instance rather than sharing state.
async function freshGetBoss() {
    vi.resetModules();
    vi.doMock('pg-boss', () => ({ default: PgBossMock }));
    vi.doMock('@/env', () => ({ env }));
    const mod = await import('./boss-client');
    return mod.getBoss;
}

describe('getBoss', () => {
    it('rejects with a clear message when DATABASE_URL is not configured', async () => {
        (env as any).DATABASE_URL = undefined;
        const getBoss = await freshGetBoss();
        await expect(getBoss()).rejects.toThrow('DATABASE_URL is required for pg-boss');
    });

    it('constructs pg-boss with the connection string and producer-only flags', async () => {
        const getBoss = await freshGetBoss();
        await getBoss();
        expect(instances[0].opts).toEqual({
            connectionString: 'postgres://test/db', noScheduling: true, noSupervisor: true,
        });
    });

    it('registers a mandatory error listener before starting', async () => {
        const getBoss = await freshGetBoss();
        await getBoss();
        expect(mockOn).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('the registered error listener logs without throwing', async () => {
        const getBoss = await freshGetBoss();
        await getBoss();
        const errorHandler = mockOn.mock.calls.find((c) => c[0] === 'error')?.[1];
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(() => errorHandler(new Error('boom'))).not.toThrow();
        expect(consoleSpy).toHaveBeenCalledWith('[pg-boss producer] error event:', expect.any(Error));
        consoleSpy.mockRestore();
    });

    it('starts the client and pre-creates every producer queue', async () => {
        const getBoss = await freshGetBoss();
        await getBoss();

        expect(mockStart).toHaveBeenCalledOnce();
        const stately = ['scheduler-scan', 'discovery-scan', 'right-sizing-scan', 'spot-guard-restore-scan', 'spot-guard-report-scan'];
        const standard = ['kb-sync', 'scheduler-reschedule', 'spot-guard-bus-policy-reconcile'];
        for (const name of stately) {
            expect(mockCreateQueue).toHaveBeenCalledWith(name, { name, policy: 'stately' });
        }
        for (const name of standard) {
            expect(mockCreateQueue).toHaveBeenCalledWith(name);
        }
        expect(mockCreateQueue).toHaveBeenCalledTimes(stately.length + standard.length);
    });

    it('caches the instance — a second call does not construct pg-boss again', async () => {
        const getBoss = await freshGetBoss();
        const first = await getBoss();
        const second = await getBoss();
        expect(first).toBe(second);
        expect(instances).toHaveLength(1);
        expect(mockStart).toHaveBeenCalledOnce();
    });

    it('tolerates a standard queue failing to create — start() still resolves', async () => {
        mockCreateQueue.mockImplementation((name: string) =>
            name === 'kb-sync' ? Promise.reject(new Error('already exists')) : Promise.resolve(undefined),
        );
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const getBoss = await freshGetBoss();
        await expect(getBoss()).resolves.toBeDefined();
        expect(consoleSpy).toHaveBeenCalledWith('[pg-boss producer] ensureQueue kb-sync failed', expect.any(Error));
        consoleSpy.mockRestore();
    });

    it('tolerates a stately queue failing to create — start() still resolves', async () => {
        mockCreateQueue.mockImplementation((name: string) =>
            name === 'scheduler-scan' ? Promise.reject(new Error('already exists')) : Promise.resolve(undefined),
        );
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const getBoss = await freshGetBoss();
        await expect(getBoss()).resolves.toBeDefined();
        expect(consoleSpy).toHaveBeenCalledWith('[pg-boss producer] ensureQueue scheduler-scan failed', expect.any(Error));
        consoleSpy.mockRestore();
    });

    it('clears the cached promise on start() failure so the next call retries with a fresh instance', async () => {
        mockStart.mockRejectedValueOnce(new Error('connection refused'));
        const getBoss = await freshGetBoss();

        await expect(getBoss()).rejects.toThrow('connection refused');
        // Give the .catch() cache-clearing microtask a tick to run.
        await new Promise((r) => setTimeout(r, 0));

        mockStart.mockResolvedValue(undefined);
        const second = await getBoss();
        expect(second).toBeDefined();
        expect(instances).toHaveLength(2); // first (failed) + second (retried)
    });
});
