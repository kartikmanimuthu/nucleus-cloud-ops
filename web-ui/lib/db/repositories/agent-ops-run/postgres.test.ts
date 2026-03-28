import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockedFunction } from 'vitest';

vi.mock('@/lib/db/pg-config', () => ({
    getPrismaClient: vi.fn(),
}));

vi.mock('uuid', () => ({ v4: vi.fn(() => 'mock-run-id') }));

import { getPrismaClient } from '@/lib/db/pg-config';
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
        };
    };

    beforeEach(() => {
        mockPrisma = {
            agentOpsRun: {
                create: vi.fn(),
                findFirst: vi.fn(),
                findMany: vi.fn(),
                updateMany: vi.fn(),
            },
        };
        vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as any);
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
            await repo.listRuns({ source: 'slack', limit: 10 });

            const callArg = mockPrisma.agentOpsRun.findMany.mock.calls[0][0];
            expect(callArg.where.source).toBe('slack');
            expect(callArg.take).toBe(10);
        });

        it('uses WHERE status= for status filter', async () => {
            mockPrisma.agentOpsRun.findMany.mockResolvedValue([]);

            const repo = new AgentOpsRunPostgresRepository();
            await repo.listRuns({ status: 'completed', limit: 5 });

            const callArg = mockPrisma.agentOpsRun.findMany.mock.calls[0][0];
            expect(callArg.where.status).toBe('completed');
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
