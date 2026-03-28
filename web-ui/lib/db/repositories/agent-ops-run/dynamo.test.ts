import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockedFunction } from 'vitest';

vi.mock('@/lib/agent-ops/models/agent-ops-run', () => ({
    AgentOpsRunModel: {
        create: vi.fn(),
        get: vi.fn(),
        update: vi.fn(),
        query: vi.fn(),
    },
}));

vi.mock('@/lib/agent-ops/dynamoose-config', () => ({
    TTL_30_DAYS: vi.fn(() => Math.floor(Date.now() / 1000) + 30 * 24 * 3600),
}));

import { AgentOpsRunModel } from '@/lib/agent-ops/models/agent-ops-run';
import { AgentOpsRunDynamoRepository } from './dynamo';

const makeRun = (overrides: Record<string, unknown> = {}) => ({
    PK: 'TENANT#t1',
    SK: 'RUN#run-1',
    GSI1PK: 'SOURCE#slack',
    GSI1SK: '2024-01-01T00:00:00.000Z#run-1',
    runId: 'run-1',
    tenantId: 't1',
    source: 'slack',
    status: 'queued',
    taskDescription: 'test task',
    mode: 'plan',
    threadId: 'agent-ops-run-1',
    trigger: { userId: 'u1', channelId: 'C1', responseUrl: 'http://x', threadTs: 'ts1' },
    autoApprove: false,
    mcpServerIds: [],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ttl: 9999999999,
    ...overrides,
});

function makeQueryChain(items: unknown[]) {
    const chain: Record<string, unknown> = {};
    const methods = ['eq', 'sort', 'limit', 'using', 'startAt', 'where', 'beginsWith'];
    for (const m of methods) {
        chain[m] = vi.fn(() => chain);
    }
    chain.exec = vi.fn().mockResolvedValue({
        toJSON: () => items,
        lastKey: undefined,
    });
    return chain;
}

describe('AgentOpsRunDynamoRepository', () => {
    let repo: AgentOpsRunDynamoRepository;

    beforeEach(() => {
        repo = new AgentOpsRunDynamoRepository();
        vi.clearAllMocks();
    });

    describe('createRun', () => {
        it('creates run with generated runId, status=queued, threadId=agent-ops-{runId}', async () => {
            vi.mocked(AgentOpsRunModel.create).mockResolvedValue(undefined as any);

            const result = await repo.createRun({
                tenantId: 't1',
                source: 'slack',
                taskDescription: 'do something',
                mode: 'plan',
                trigger: { userId: 'u1', channelId: 'C1', responseUrl: 'http://x' },
            });

            expect(result.runId).toBeTruthy();
            expect(result.status).toBe('queued');
            expect(result.threadId).toBe(`agent-ops-${result.runId}`);
            expect(AgentOpsRunModel.create).toHaveBeenCalledOnce();
        });
    });

    describe('getRun', () => {
        it('returns run when found', async () => {
            const run = makeRun();
            vi.mocked(AgentOpsRunModel.get).mockResolvedValue({ toJSON: () => run } as any);

            const result = await repo.getRun('t1', 'run-1');
            expect(result).not.toBeNull();
        });

        it('returns null when not found', async () => {
            vi.mocked(AgentOpsRunModel.get).mockRejectedValue(new Error('not found'));

            const result = await repo.getRun('t1', 'missing');
            expect(result).toBeNull();
        });
    });

    describe('listRuns', () => {
        it('queries GSI1 by source when source provided', async () => {
            const chain = makeQueryChain([makeRun()]);
            vi.mocked(AgentOpsRunModel.query).mockReturnValue(chain as any);

            const result = await repo.listRuns({ source: 'slack', limit: 10 });
            expect(AgentOpsRunModel.query).toHaveBeenCalledWith('GSI1PK');
            expect(result.runs).toHaveLength(1);
        });

        it('queries all 3 sources in parallel when no source provided', async () => {
            const chain = makeQueryChain([]);
            vi.mocked(AgentOpsRunModel.query).mockReturnValue(chain as any);

            await repo.listRuns({ limit: 10 });
            expect(AgentOpsRunModel.query).toHaveBeenCalledTimes(3);
        });
    });

    describe('findAwaitingApprovalRun', () => {
        it('scans sources and returns matching run', async () => {
            const run = makeRun({ status: 'awaiting_approval', runId: 'run-x' });
            const chain = makeQueryChain([run]);
            vi.mocked(AgentOpsRunModel.query).mockReturnValue(chain as any);

            const result = await repo.findAwaitingApprovalRun('run-x');
            expect(result).not.toBeNull();
            expect(result?.runId).toBe('run-x');
        });

        it('returns null when no matching run found', async () => {
            const chain = makeQueryChain([]);
            vi.mocked(AgentOpsRunModel.query).mockReturnValue(chain as any);

            const result = await repo.findAwaitingApprovalRun('run-missing');
            expect(result).toBeNull();
        });
    });
});
