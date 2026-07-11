import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn().mockResolvedValue('job-1');
const mockCreateQueue = vi.fn().mockResolvedValue(undefined);
const mockUpdateQueue = vi.fn().mockResolvedValue(undefined);
const mockWork = vi.fn().mockResolvedValue(undefined);

const mockBoss = {
    send: mockSend,
    createQueue: mockCreateQueue,
    updateQueue: mockUpdateQueue,
    work: mockWork,
} as any;

const mockFindMany = vi.fn();

const mockUpdateMany = vi.fn().mockResolvedValue({ count: 1 });

vi.mock('@prisma/client', () => ({
    PrismaClient: vi.fn().mockImplementation(() => ({
        scheduledTask: { findMany: mockFindMany, updateMany: mockUpdateMany },
    })),
}));

import { sweep, selectDueTasks, type ActiveTaskRow } from './index.js';

const task = (over: Partial<ActiveTaskRow> = {}): ActiveTaskRow => ({
    taskId: 't1',
    tenantId: 'ten-1',
    scheduleType: 'cron',
    cronExpression: '* * * * *',
    intervalMinutes: null,
    timezone: 'UTC',
    nextRunAt: null,
    ...over,
});

const intervalTask = (over: Partial<ActiveTaskRow> = {}): ActiveTaskRow => task({
    scheduleType: 'interval',
    cronExpression: '',
    intervalMinutes: 60,
    ...over,
});

describe('selectDueTasks', () => {
    it('selects a task whose previous scheduled run is within the window', () => {
        // Every-minute cron; ref at 12:00:30 → previous run 12:00:00 → 30s ago < 60s.
        const now = Date.UTC(2026, 0, 1, 12, 0, 30);
        const due = selectDueTasks([task({ cronExpression: '* * * * *' })], now, 60_000);
        expect(due.map((t) => t.taskId)).toEqual(['t1']);
    });

    it('excludes a task whose previous run is older than the window', () => {
        // Daily midnight; ref at noon → previous run 00:00 → 12h ago.
        const now = Date.UTC(2026, 0, 1, 12, 0, 0);
        const due = selectDueTasks([task({ cronExpression: '0 0 * * *' })], now, 60_000);
        expect(due).toEqual([]);
    });

    it('skips a task with a malformed cron expression (never throws)', () => {
        const now = Date.UTC(2026, 0, 1, 12, 0, 0);
        const due = selectDueTasks([task({ taskId: 'bad', cronExpression: 'not-a-cron' })], now, 60_000);
        expect(due).toEqual([]);
    });

    it('selects an interval task whose nextRunAt anchor has passed', () => {
        const now = Date.UTC(2026, 0, 1, 12, 0, 0);
        const due = selectDueTasks(
            [intervalTask({ nextRunAt: new Date(now - 1_000) })],
            now,
            60_000,
        );
        expect(due.map((t) => t.taskId)).toEqual(['t1']);
    });

    it('selects an interval task with a null anchor (fires once, then advanced)', () => {
        const now = Date.UTC(2026, 0, 1, 12, 0, 0);
        const due = selectDueTasks([intervalTask({ nextRunAt: null })], now, 60_000);
        expect(due.map((t) => t.taskId)).toEqual(['t1']);
    });

    it('excludes an interval task whose anchor is in the future', () => {
        const now = Date.UTC(2026, 0, 1, 12, 0, 0);
        const due = selectDueTasks(
            [intervalTask({ nextRunAt: new Date(now + 60_000) })],
            now,
            60_000,
        );
        expect(due).toEqual([]);
    });

    it('skips an interval task without intervalMinutes (never throws)', () => {
        const now = Date.UTC(2026, 0, 1, 12, 0, 0);
        const due = selectDueTasks(
            [intervalTask({ intervalMinutes: null, nextRunAt: new Date(now - 1_000) })],
            now,
            60_000,
        );
        expect(due).toEqual([]);
    });
});

describe('sweep', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockSend.mockResolvedValue('job-1');
        mockUpdateMany.mockResolvedValue({ count: 1 });
    });

    it('enqueues one tick per due task with a per-task de-dup key', async () => {
        // Every-minute cron is always due relative to Date.now().
        mockFindMany.mockResolvedValue([task({ taskId: 't1', tenantId: 'ten-1', cronExpression: '* * * * *' })]);
        await sweep(mockBoss);
        expect(mockSend).toHaveBeenCalledWith(
            'agent-ops-tick',
            { taskId: 't1', tenantId: 'ten-1' },
            expect.objectContaining({ singletonKey: 'task:t1', singletonSeconds: 60 }),
        );
    });

    it('enqueues nothing when no active task is due', async () => {
        mockFindMany.mockResolvedValue([task({ cronExpression: '0 0 * * *' })]); // daily — not due right now
        await sweep(mockBoss);
        expect(mockSend).not.toHaveBeenCalled();
    });

    it('advances the interval anchor after enqueueing an interval tick', async () => {
        mockFindMany.mockResolvedValue([
            intervalTask({ taskId: 'i1', tenantId: 'ten-2', nextRunAt: new Date(Date.now() - 1_000) }),
        ]);
        await sweep(mockBoss);
        expect(mockSend).toHaveBeenCalledWith(
            'agent-ops-tick',
            { taskId: 'i1', tenantId: 'ten-2' },
            expect.objectContaining({ singletonKey: 'task:i1' }),
        );
        expect(mockUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { tenantId: 'ten-2', taskId: 'i1' },
            data: { nextRunAt: expect.any(Date) },
        }));
    });

    it('does not touch the anchor for cron tasks', async () => {
        mockFindMany.mockResolvedValue([task({ cronExpression: '* * * * *' })]);
        await sweep(mockBoss);
        expect(mockSend).toHaveBeenCalled();
        expect(mockUpdateMany).not.toHaveBeenCalled();
    });

    it('skips a concurrent sweep while one is still in flight', async () => {
        let resolveFirst!: (rows: unknown[]) => void;
        const gate = new Promise<unknown[]>((resolve) => { resolveFirst = resolve; });
        mockFindMany.mockImplementationOnce(() => gate);

        const first = sweep(mockBoss);
        const second = sweep(mockBoss);
        await second; // guard-blocked, returns immediately

        await vi.waitFor(() => expect(mockFindMany).toHaveBeenCalledTimes(1));
        resolveFirst([]);
        await first;

        expect(mockFindMany).toHaveBeenCalledTimes(1);
    });
});
