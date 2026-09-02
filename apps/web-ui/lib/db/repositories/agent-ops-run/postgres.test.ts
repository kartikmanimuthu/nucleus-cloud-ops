import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockedFunction } from 'vitest';

vi.mock('@/lib/db/pg-config', async (importOriginal) => ({
    // andWhere (Gate 3 row filtering) is real; only the client factories are mocked.
    ...(await importOriginal<typeof import('@/lib/db/pg-config')>()),
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

        it('defaults trigger to {} when the caller supplies none', async () => {
            mockPrisma.agentOpsRun.create.mockResolvedValue(makeRunRow());
            const repo = new AgentOpsRunPostgresRepository();
            await repo.createRun({ tenantId: 't1', source: 'slack', taskDescription: 'x', mode: 'plan' } as any);
            expect(mockPrisma.agentOpsRun.create.mock.calls[0][0].data.trigger).toEqual({});
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

        it('returns null when no matching run exists', async () => {
            mockPrisma.agentOpsRun.findFirst.mockResolvedValue(null);
            const repo = new AgentOpsRunPostgresRepository();
            expect(await repo.findAwaitingApprovalRunByJiraIssue('PROJ-999')).toBeNull();
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

        it('sets completedAt/durationMs on a failed status too', async () => {
            mockPrisma.agentOpsRun.findFirst.mockResolvedValue(
                makeRunRow({ createdAt: new Date('2024-01-01T00:00:00Z') })
            );
            mockPrisma.agentOpsRun.updateMany.mockResolvedValue({ count: 1 });
            const repo = new AgentOpsRunPostgresRepository();
            await repo.updateRunStatus('t1', 'run-1', 'failed');
            expect(mockPrisma.agentOpsRun.updateMany.mock.calls[0][0].data.completedAt).toBeDefined();
        });

        it('does not set completedAt/durationMs on a non-terminal status', async () => {
            mockPrisma.agentOpsRun.updateMany.mockResolvedValue({ count: 1 });
            const repo = new AgentOpsRunPostgresRepository();
            await repo.updateRunStatus('t1', 'run-1', 'in_progress');
            const data = mockPrisma.agentOpsRun.updateMany.mock.calls[0][0].data;
            expect(data).not.toHaveProperty('completedAt');
            expect(data).not.toHaveProperty('durationMs');
            expect(mockPrisma.agentOpsRun.findFirst).not.toHaveBeenCalled(); // no need to look up createdAt
        });

        it('skips durationMs when the prior run cannot be found (no createdAt to diff against)', async () => {
            mockPrisma.agentOpsRun.findFirst.mockResolvedValue(null);
            mockPrisma.agentOpsRun.updateMany.mockResolvedValue({ count: 1 });
            const repo = new AgentOpsRunPostgresRepository();
            await repo.updateRunStatus('t1', 'run-1', 'completed');
            expect(mockPrisma.agentOpsRun.updateMany.mock.calls[0][0].data).not.toHaveProperty('durationMs');
        });

        it('passes through result/error/clarification/approvalRequest only when present', async () => {
            mockPrisma.agentOpsRun.updateMany.mockResolvedValue({ count: 1 });
            const repo = new AgentOpsRunPostgresRepository();
            await repo.updateRunStatus('t1', 'run-1', 'in_progress', {
                result: { ok: true }, error: 'oops', clarification: { q: 'x' }, approvalRequest: { a: 'x' },
            } as any);
            const data = mockPrisma.agentOpsRun.updateMany.mock.calls[0][0].data;
            expect(data.result).toEqual({ ok: true });
            expect(data.error).toBe('oops');
            expect(data.clarification).toEqual({ q: 'x' });
            expect(data.approvalRequest).toEqual({ a: 'x' });
        });

        it('omits result/error/clarification/approvalRequest when extra is not given', async () => {
            mockPrisma.agentOpsRun.updateMany.mockResolvedValue({ count: 1 });
            const repo = new AgentOpsRunPostgresRepository();
            await repo.updateRunStatus('t1', 'run-1', 'in_progress');
            const data = mockPrisma.agentOpsRun.updateMany.mock.calls[0][0].data;
            expect(data).not.toHaveProperty('result');
            expect(data).not.toHaveProperty('error');
        });
    });

    describe('updateRunTrigger', () => {
        it('overwrites the trigger JSON and bumps updatedAt', async () => {
            mockPrisma.agentOpsRun.updateMany.mockResolvedValue({ count: 1 });
            const repo = new AgentOpsRunPostgresRepository();
            await repo.updateRunTrigger('t1', 'run-1', { userId: 'u1' } as any);
            expect(mockPrisma.agentOpsRun.updateMany).toHaveBeenCalledWith({
                where: { tenantId: 't1', runId: 'run-1' },
                data: { trigger: { userId: 'u1' }, updatedAt: expect.any(Date) },
            });
        });
    });

    describe('updateApprovalMessageTs', () => {
        it('merges slackMessageTs into the existing approvalRequest', async () => {
            mockPrisma.agentOpsRun.findFirst.mockResolvedValue(
                makeRunRow({ approvalRequest: { approvers: ['a@b.co'] } })
            );
            mockPrisma.agentOpsRun.updateMany.mockResolvedValue({ count: 1 });

            const repo = new AgentOpsRunPostgresRepository();
            await repo.updateApprovalMessageTs('t1', 'run-1', 'ts-123');

            expect(mockPrisma.agentOpsRun.updateMany.mock.calls[0][0].data.approvalRequest).toEqual({
                approvers: ['a@b.co'], slackMessageTs: 'ts-123',
            });
        });

        it('no-ops when the run has no approvalRequest at all', async () => {
            mockPrisma.agentOpsRun.findFirst.mockResolvedValue(makeRunRow({ approvalRequest: null }));
            const repo = new AgentOpsRunPostgresRepository();
            await repo.updateApprovalMessageTs('t1', 'run-1', 'ts-123');
            expect(mockPrisma.agentOpsRun.updateMany).not.toHaveBeenCalled();
        });

        it('no-ops when the run itself does not exist', async () => {
            mockPrisma.agentOpsRun.findFirst.mockResolvedValue(null);
            const repo = new AgentOpsRunPostgresRepository();
            await repo.updateApprovalMessageTs('t1', 'missing', 'ts-123');
            expect(mockPrisma.agentOpsRun.updateMany).not.toHaveBeenCalled();
        });
    });

    describe('listRuns — sorting', () => {
        it('defaults to createdAt desc when no sortBy is given', async () => {
            mockPrisma.agentOpsRun.findMany.mockResolvedValue([]);
            const repo = new AgentOpsRunPostgresRepository();
            await repo.listRuns({ tenantId: 't1' });
            expect(mockPrisma.agentOpsRun.findMany.mock.calls[0][0].orderBy).toEqual({ createdAt: 'desc' });
        });

        it('sorts by the given column and direction', async () => {
            mockPrisma.agentOpsRun.findMany.mockResolvedValue([]);
            const repo = new AgentOpsRunPostgresRepository();
            await repo.listRuns({ tenantId: 't1', sortBy: 'status', sortDir: 'asc' });
            expect(mockPrisma.agentOpsRun.findMany.mock.calls[0][0].orderBy).toEqual({ status: 'asc' });
        });

        it('defaults sortDir to desc when a sortBy is given without a direction', async () => {
            mockPrisma.agentOpsRun.findMany.mockResolvedValue([]);
            const repo = new AgentOpsRunPostgresRepository();
            await repo.listRuns({ tenantId: 't1', sortBy: 'taskDescription' });
            expect(mockPrisma.agentOpsRun.findMany.mock.calls[0][0].orderBy).toEqual({ taskDescription: 'desc' });
        });

        it('throws when tenantId is missing', async () => {
            const repo = new AgentOpsRunPostgresRepository();
            await expect(repo.listRuns({} as any)).rejects.toThrow('listRuns: tenantId is required');
        });

        it('intersects a Gate-3 row filter under AND', async () => {
            mockPrisma.agentOpsRun.findMany.mockResolvedValue([]);
            const repo = new AgentOpsRunPostgresRepository();
            await repo.listRuns({ tenantId: 't1', rowFilter: { accountId: { in: ['a1'] } } });
            expect(mockPrisma.agentOpsRun.findMany.mock.calls[0][0].where.AND).toEqual([{ accountId: { in: ['a1'] } }]);
        });
    });

    describe('listActiveRunsByTask', () => {
        it('filters by scheduled source, active statuses, and the trigger.taskId JSON path', async () => {
            mockPrisma.agentOpsRun.findMany.mockResolvedValue([makeRunRow({ source: 'scheduled' })]);
            const repo = new AgentOpsRunPostgresRepository();
            await repo.listActiveRunsByTask('t1', 'task-1');

            const call = mockPrisma.agentOpsRun.findMany.mock.calls[0][0];
            expect(call.where.source).toBe('scheduled');
            expect(call.where.status).toEqual({ in: ['queued', 'in_progress', 'awaiting_input', 'awaiting_approval'] });
            expect(call.where.trigger).toEqual({ path: ['taskId'], equals: 'task-1' });
        });
    });

    describe('listRunsBySource', () => {
        it('queries cross-tenant via the unscoped client, filtered by source, defaulting limit to 25', async () => {
            mockPrisma.agentOpsRun.findMany.mockResolvedValue([makeRunRow()]);
            const repo = new AgentOpsRunPostgresRepository();
            await repo.listRunsBySource('slack');
            expect(getPrismaClient).toHaveBeenCalled();
            const call = mockPrisma.agentOpsRun.findMany.mock.calls[0][0];
            expect(call.where).toEqual({ source: 'slack' });
            expect(call.take).toBe(25);
        });

        it('honors an explicit limit', async () => {
            mockPrisma.agentOpsRun.findMany.mockResolvedValue([]);
            const repo = new AgentOpsRunPostgresRepository();
            await repo.listRunsBySource('jira', 5);
            expect(mockPrisma.agentOpsRun.findMany.mock.calls[0][0].take).toBe(5);
        });
    });

    describe('findAwaitingRunByJiraIssue', () => {
        it('filters by awaiting_input status, jira source, and issueKey JSON path', async () => {
            mockPrisma.agentOpsRun.findFirst.mockResolvedValue(makeRunRow({ source: 'jira', status: 'awaiting_input' }));
            const repo = new AgentOpsRunPostgresRepository();
            const result = await repo.findAwaitingRunByJiraIssue('PROJ-9');
            const call = mockPrisma.agentOpsRun.findFirst.mock.calls[0][0];
            expect(call.where).toEqual({ status: 'awaiting_input', source: 'jira', trigger: { path: ['issueKey'], equals: 'PROJ-9' } });
            expect(result).not.toBeNull();
        });

        it('returns null when nothing matches', async () => {
            mockPrisma.agentOpsRun.findFirst.mockResolvedValue(null);
            const repo = new AgentOpsRunPostgresRepository();
            expect(await repo.findAwaitingRunByJiraIssue('PROJ-9')).toBeNull();
        });
    });

    describe('findAwaitingRunBySlackThread — threadTs verification', () => {
        it('returns null when the channel matches but threadTs does not', async () => {
            mockPrisma.agentOpsRun.findFirst.mockResolvedValue(
                makeRunRow({ trigger: { channelId: 'C1', threadTs: 'other-ts' } }),
            );
            const repo = new AgentOpsRunPostgresRepository();
            expect(await repo.findAwaitingRunBySlackThread('C1', 'ts1')).toBeNull();
        });

        it('returns null immediately when no channel-matching run exists', async () => {
            mockPrisma.agentOpsRun.findFirst.mockResolvedValue(null);
            const repo = new AgentOpsRunPostgresRepository();
            expect(await repo.findAwaitingRunBySlackThread('C1', 'ts1')).toBeNull();
        });
    });

    describe('findResumableTelegramRun', () => {
        it('filters by telegram source, awaiting_input status, idle cutoff, and chatId JSON path', async () => {
            mockPrisma.agentOpsRun.findFirst.mockResolvedValue(makeRunRow({ source: 'telegram', status: 'awaiting_input' }));
            const cutoff = new Date('2026-01-01T00:00:00Z');

            const repo = new AgentOpsRunPostgresRepository();
            const result = await repo.findResumableTelegramRun(12345, cutoff);

            const call = mockPrisma.agentOpsRun.findFirst.mock.calls[0][0];
            expect(call.where).toEqual({
                source: 'telegram', status: 'awaiting_input', updatedAt: { gte: cutoff },
                trigger: { path: ['chatId'], equals: 12345 },
            });
            expect(result).not.toBeNull();
        });

        it('returns null when no resumable run exists', async () => {
            mockPrisma.agentOpsRun.findFirst.mockResolvedValue(null);
            const repo = new AgentOpsRunPostgresRepository();
            expect(await repo.findResumableTelegramRun(12345, new Date())).toBeNull();
        });
    });

    describe('toAgentOpsRun — optional field mapping', () => {
        it('defaults accountId/accountName/selectedSkill/model/error/durationMs to undefined when null', async () => {
            mockPrisma.agentOpsRun.findFirst.mockResolvedValue(makeRunRow({
                accountId: null, accountName: null, selectedSkill: null, model: null, error: null, durationMs: null, completedAt: null,
            }));
            const repo = new AgentOpsRunPostgresRepository();
            const run = await repo.getRun('t1', 'run-1');
            expect(run?.accountId).toBeUndefined();
            expect(run?.model).toBeUndefined();
            expect(run?.completedAt).toBeUndefined();
        });

        it('converts a populated completedAt to an ISO string and derives ttl from expiresAt', async () => {
            mockPrisma.agentOpsRun.findFirst.mockResolvedValue(makeRunRow({
                completedAt: new Date('2024-01-02T00:00:00Z'),
                expiresAt: new Date('2024-02-01T00:00:00Z'),
            }));
            const repo = new AgentOpsRunPostgresRepository();
            const run = await repo.getRun('t1', 'run-1');
            expect(run?.completedAt).toBe('2024-01-02T00:00:00.000Z');
            expect(run?.ttl).toBe(Math.floor(new Date('2024-02-01T00:00:00Z').getTime() / 1000));
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
