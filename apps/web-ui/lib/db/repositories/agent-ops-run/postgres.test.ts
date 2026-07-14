import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockedFunction } from 'vitest';

vi.mock('@/lib/db/pg-config', () => ({
    getPrismaClient: vi.fn(),
    getTenantClient: vi.fn(),
}));

vi.mock('uuid', () => ({ v4: vi.fn(() => 'mock-run-id') }));

import { getPrismaClient, getTenantClient } from '@/lib/db/pg-config';
import { AgentOpsRunPostgresRepository } from './postgres';

const makeRunRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'cuid-1',
    tenantId: 't1',
    runId: 'run-1',
    source: 'slack',
    status: 'queued',
    taskDescription: 'test task',
    mode: 'plan',
    accountId: null,
    accountName: null,
    selectedSkill: null,
    autoApprove: false,
    model: null,
    threadId: 'agent-ops-run-1',
    mcpServerIds: [],
    trigger: { userId: 'u1', channelId: 'C1', responseUrl: 'http://x', threadTs: 'ts1' },
    result: null,
    clarification: null,
    approvalRequest: null,
    error: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    completedAt: null,
    durationMs: null,
    expiresAt: new Date('2024-02-01T00:00:00Z'),
    ...overrides,
});

describe('AgentOpsRunPostgresRepository', () => {
    let mockPrisma: {
        agentOpsRun: {
            create: MockedFunction<any>;
            findFirst: MockedFunction<any>;
            findMany: MockedFunction<any>;
            updateMany: MockedFunction<any>;
            count: MockedFunction<any>;
        };
    };

    beforeEach(() => {
        mockPrisma = {
            agentOpsRun: {
                create: vi.fn(),
                findFirst: vi.fn(),
                findMany: vi.fn(),
                updateMany: vi.fn(),
                count: vi.fn().mockResolvedValue(0),
            },
        };
        vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as any);
        vi.mocked(getTenantClient).mockReturnValue(mockPrisma as any);
    });

    describe('createRun', () => {
        it('creates run with generated runId, status=queued, threadId=agent-ops-{runId}', async () => {
            mockPrisma.agentOpsRun.create.mockResolvedValue(
                makeRunRow({ runId: 'mock-run-id', threadId: 'agent-ops-mock-run-id' })
            );

            const repo = new AgentOpsRunPostgresRepository();
            const result = await repo.createRun({
                tenantId: 't1',
                source: 'slack',
                taskDescription: 'do something',
                mode: 'plan',
                trigger: { userId: 'u1', channelId: 'C1', responseUrl: 'http://x' },
            });

            expect(result.runId).toBe('mock-run-id');
            expect(result.status).toBe('queued');
            expect(result.threadId).toBe('agent-ops-mock-run-id');
            expect(mockPrisma.agentOpsRun.create).toHaveBeenCalledOnce();
        });
    });

    describe('getRun', () => {
        it('returns run scoped by tenantId', async () => {
            mockPrisma.agentOpsRun.findFirst.mockResolvedValue(makeRunRow());

            const repo = new AgentOpsRunPostgresRepository();
            const result = await repo.getRun('t1', 'run-1');

            expect(mockPrisma.agentOpsRun.findFirst).toHaveBeenCalledWith(
                expect.objectContaining({ where: expect.objectContaining({ tenantId: 't1', runId: 'run-1' }) })
            );
            expect(result).not.toBeNull();
            expect(result!.runId).toBe('run-1');
        });

        it('returns null when not found', async () => {
            mockPrisma.agentOpsRun.findFirst.mockResolvedValue(null);

            const repo = new AgentOpsRunPostgresRepository();
            const result = await repo.getRun('t1', 'missing');
            expect(result).toBeNull();
        });

        it('enforces cross-tenant isolation — different tenantId returns null', async () => {
            mockPrisma.agentOpsRun.findFirst.mockResolvedValue(null);

            const repo = new AgentOpsRunPostgresRepository();
            const result = await repo.getRun('other-tenant', 'run-1');

            expect(mockPrisma.agentOpsRun.findFirst).toHaveBeenCalledWith(
                expect.objectContaining({ where: expect.objectContaining({ tenantId: 'other-tenant' }) })
            );
            expect(result).toBeNull();
        });
    });

    describe('listRuns', () => {
        it('uses WHERE source= for source filter (server-side, not GSI scan)', async () => {
            mockPrisma.agentOpsRun.findMany.mockResolvedValue([makeRunRow()]);

            const repo = new AgentOpsRunPostgresRepository();
            const result = await repo.listRuns({ tenantId: 't1', source: 'slack', limit: 10 });

            const callArg = mockPrisma.agentOpsRun.findMany.mock.calls[0][0];
            expect(callArg.where.source).toBe('slack');
            expect(callArg.take).toBe(10);
            expect(callArg.skip).toBe(0);
            expect(result.runs).toHaveLength(1);
            expect(result.total).toBe(0);
            expect(result.stats).toEqual({ total: 0, inProgress: 0, completed: 0, failed: 0 });
        });

        it('uses WHERE status= for status filter', async () => {
            mockPrisma.agentOpsRun.findMany.mockResolvedValue([]);

            const repo = new AgentOpsRunPostgresRepository();
            const result = await repo.listRuns({ tenantId: 't1', status: 'completed', limit: 5 });

            const callArg = mockPrisma.agentOpsRun.findMany.mock.calls[0][0];
            expect(callArg.where.status).toBe('completed');
            expect(result.runs).toEqual([]);
        });

        // Scheduled-task run history used to fetch a tenant-wide page of scheduled runs
        // and filter by taskId in JS, which silently dropped a task's older runs once
        // other tasks filled the window — and made `total` a tenant-wide count. The
        // filter must reach SQL.
        it('filters by taskId in the query (trigger JSON path), not in memory', async () => {
            mockPrisma.agentOpsRun.findMany.mockResolvedValue([makeRunRow({ source: 'scheduled' })]);
            mockPrisma.agentOpsRun.count.mockResolvedValue(7);

            const repo = new AgentOpsRunPostgresRepository();
            const result = await repo.listRuns({
                tenantId: 't1',
                source: 'scheduled',
                taskId: 'task-42',
                page: 2,
                limit: 25,
            });

            const callArg = mockPrisma.agentOpsRun.findMany.mock.calls[0][0];
            expect(callArg.where.trigger).toEqual({ path: ['taskId'], equals: 'task-42' });
            expect(callArg.where.source).toBe('scheduled');
            expect(callArg.skip).toBe(25);
            expect(callArg.take).toBe(25);

            // The same where-clause must drive the count, or the pagination bar lies.
            const countArg = mockPrisma.agentOpsRun.count.mock.calls[0][0];
            expect(countArg.where.trigger).toEqual({ path: ['taskId'], equals: 'task-42' });
            expect(result.total).toBe(7);
        });

        it('omits the trigger filter when no taskId is given', async () => {
            mockPrisma.agentOpsRun.findMany.mockResolvedValue([]);

            const repo = new AgentOpsRunPostgresRepository();
            await repo.listRuns({ tenantId: 't1', source: 'scheduled' });

            const callArg = mockPrisma.agentOpsRun.findMany.mock.calls[0][0];
            expect(callArg.where.trigger).toBeUndefined();
        });
    });

    describe('findAwaitingApprovalRun', () => {
        it('uses WHERE runId+status instead of scanning 3 sources (AOPS-06)', async () => {
            mockPrisma.agentOpsRun.findFirst.mockResolvedValue(
                makeRunRow({ status: 'awaiting_approval' })
            );

            const repo = new AgentOpsRunPostgresRepository();
            const result = await repo.findAwaitingApprovalRun('run-1');

            expect(mockPrisma.agentOpsRun.findFirst).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({ runId: 'run-1', status: 'awaiting_approval' }),
                })
            );
            expect(result).not.toBeNull();
        });

        it('returns null when run not in awaiting_approval status', async () => {
            mockPrisma.agentOpsRun.findFirst.mockResolvedValue(null);

            const repo = new AgentOpsRunPostgresRepository();
            const result = await repo.findAwaitingApprovalRun('run-queued');
            expect(result).toBeNull();
        });
    });

    describe('findAwaitingApprovalRunByJiraIssue', () => {
        it('uses JSON path filter on trigger.issueKey', async () => {
            mockPrisma.agentOpsRun.findFirst.mockResolvedValue(
                makeRunRow({ source: 'jira', status: 'awaiting_approval' })
            );

            const repo = new AgentOpsRunPostgresRepository();
            await repo.findAwaitingApprovalRunByJiraIssue('PROJ-123');

            const callArg = mockPrisma.agentOpsRun.findFirst.mock.calls[0][0];
            expect(callArg.where.status).toBe('awaiting_approval');
            expect(callArg.where.source).toBe('jira');
            expect(callArg.where.trigger).toEqual({ path: ['issueKey'], equals: 'PROJ-123' });
        });
    });

    describe('findAwaitingRunBySlackThread', () => {
        it('uses JSON path filter on trigger.channelId + status', async () => {
            mockPrisma.agentOpsRun.findFirst.mockResolvedValue(
                makeRunRow({ source: 'slack', status: 'awaiting_input' })
            );

            const repo = new AgentOpsRunPostgresRepository();
            await repo.findAwaitingRunBySlackThread('C1', 'ts1');

            const callArg = mockPrisma.agentOpsRun.findFirst.mock.calls[0][0];
            expect(callArg.where.status).toBe('awaiting_input');
            expect(callArg.where.source).toBe('slack');
            expect(callArg.where.trigger).toEqual({ path: ['channelId'], equals: 'C1' });
        });
    });

    describe('updateRunStatus', () => {
        it('sets completedAt and durationMs on terminal status', async () => {
            mockPrisma.agentOpsRun.findFirst.mockResolvedValue(
                makeRunRow({ createdAt: new Date('2024-01-01T00:00:00Z') })
            );
            mockPrisma.agentOpsRun.updateMany.mockResolvedValue({ count: 1 });

            const repo = new AgentOpsRunPostgresRepository();
            await repo.updateRunStatus('t1', 'run-1', 'completed');

            const callArg = mockPrisma.agentOpsRun.updateMany.mock.calls[0][0];
            expect(callArg.data.completedAt).toBeDefined();
            expect(callArg.data.durationMs).toBeGreaterThan(0);
        });
    });
});

describe('AgentOpsRunPostgresRepository — tenant isolation', () => {
    let mockPrisma: {
        agentOpsRun: {
            create: MockedFunction<any>;
            findFirst: MockedFunction<any>;
            findMany: MockedFunction<any>;
            updateMany: MockedFunction<any>;
            count: MockedFunction<any>;
        };
    };

    beforeEach(() => {
        mockPrisma = {
            agentOpsRun: {
                create: vi.fn(),
                findFirst: vi.fn().mockResolvedValue(null),
                findMany: vi.fn().mockResolvedValue([]),
                updateMany: vi.fn().mockResolvedValue({ count: 1 }),
                count: vi.fn().mockResolvedValue(0),
            },
        };
        vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as any);
        vi.mocked(getTenantClient).mockReturnValue(mockPrisma as any);
    });

    it('createRun calls getTenantClient with correct tenantId', async () => {
        mockPrisma.agentOpsRun.create.mockResolvedValue(makeRunRow({ runId: 'mock-run-id', threadId: 'agent-ops-mock-run-id' }));
        const repo = new AgentOpsRunPostgresRepository();
        await repo.createRun({
            tenantId: 'tenant-test',
            source: 'slack',
            taskDescription: 'test',
            mode: 'plan',
            trigger: { userId: 'u1', channelId: 'C1', responseUrl: 'http://x' },
        });
        expect(getTenantClient).toHaveBeenCalledWith('tenant-test');
    });

    it('getRun calls getTenantClient with correct tenantId', async () => {
        const repo = new AgentOpsRunPostgresRepository();
        await repo.getRun('tenant-test', 'run-1');
        expect(getTenantClient).toHaveBeenCalledWith('tenant-test');
    });

    it('listRuns calls getTenantClient with correct tenantId', async () => {
        const repo = new AgentOpsRunPostgresRepository();
        await repo.listRuns({ tenantId: 'tenant-test', limit: 10 });
        expect(getTenantClient).toHaveBeenCalledWith('tenant-test');
    });

    it('updateRunStatus calls getTenantClient with correct tenantId', async () => {
        const repo = new AgentOpsRunPostgresRepository();
        await repo.updateRunStatus('tenant-test', 'run-1', 'completed');
        expect(getTenantClient).toHaveBeenCalledWith('tenant-test');
    });
});
