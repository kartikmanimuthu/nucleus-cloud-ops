import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreateQueue = vi.fn().mockResolvedValue(undefined);
const mockWork = vi.fn().mockResolvedValue(undefined);
const mockSchedule = vi.fn().mockResolvedValue(undefined);
const mockUnschedule = vi.fn().mockResolvedValue(undefined);

const mockBoss = {
    createQueue: mockCreateQueue,
    work: mockWork,
    schedule: mockSchedule,
    unschedule: mockUnschedule,
} as any;

const mockExecutor = {
    registerHandler: vi.fn(),
    execute: vi.fn().mockResolvedValue(undefined),
} as any;

const mockFindMany = vi.fn();

vi.mock('@prisma/client', () => ({
    PrismaClient: vi.fn().mockImplementation(() => ({
        scheduledTask: { findMany: mockFindMany },
    })),
}));

import { syncSchedules } from './index.js';

describe('syncSchedules re-entrancy guard', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('skips a concurrent sync while one is already in flight', async () => {
        let resolveFirst!: (rows: unknown[]) => void;
        const firstCallGate = new Promise<unknown[]>((resolve) => {
            resolveFirst = resolve;
        });
        mockFindMany.mockImplementationOnce(() => firstCallGate);

        // syncInFlight is set synchronously before the first await inside
        // syncSchedules, so firing the second call right after the first
        // (with no await in between) reliably races them.
        const firstSync = syncSchedules(mockBoss, mockExecutor);
        const secondSync = syncSchedules(mockBoss, mockExecutor);

        // The second call should short-circuit immediately (guard-blocked)
        // without ever reaching Prisma.
        await secondSync;

        // Let the first call's async chain (dynamic import + query) actually
        // reach the gated findMany call before unblocking it.
        await vi.waitFor(() => expect(mockFindMany).toHaveBeenCalledTimes(1));

        resolveFirst([]);
        await firstSync;

        expect(mockFindMany).toHaveBeenCalledTimes(1);
    });

    it('allows a new sync to run once the previous one has completed', async () => {
        mockFindMany.mockResolvedValue([]);

        await syncSchedules(mockBoss, mockExecutor);
        await syncSchedules(mockBoss, mockExecutor);

        expect(mockFindMany).toHaveBeenCalledTimes(2);
    });
});
