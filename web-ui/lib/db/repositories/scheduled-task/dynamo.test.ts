import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/agent-ops/models/scheduled-task', () => ({
    ScheduledTaskModel: {
        create: vi.fn(),
        get: vi.fn(),
        update: vi.fn(),
        query: vi.fn(),
    },
}));

vi.mock('@aws-sdk/client-dynamodb', () => ({
    DynamoDBClient: vi.fn().mockImplementation(() => ({ send: vi.fn() })),
    PutItemCommand: vi.fn(),
}));

vi.mock('@/lib/agent-ops/dynamoose-config', () => ({
    AGENT_OPS_TABLE_NAME: 'test-table',
}));

vi.mock('croner', () => ({
    Cron: vi.fn().mockImplementation(() => ({
        nextRun: vi.fn(() => new Date('2024-02-01T00:00:00Z')),
        stop: vi.fn(),
    })),
}));

import { ScheduledTaskModel } from '@/lib/agent-ops/models/scheduled-task';
import { ScheduledTaskDynamoRepository } from './dynamo';

const makeTask = (overrides: Record<string, unknown> = {}) => ({
    PK: 'TENANT#t1',
    SK: 'SCHED#task-1',
    GSI1PK: 'TYPE#SCHEDULED_TASK',
    GSI1SK: 't1#task-1',
    taskId: 'task-1',
    tenantId: 't1',
    name: 'Daily Cleanup',
    description: 'Runs daily',
    cronExpression: '0 2 * * *',
    timezone: 'UTC',
    taskStatus: 'active',
    mode: 'plan',
    autoApprove: false,
    notification: { type: 'none' },
    runCount: 0,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    createdBy: 'user-1',
    ...overrides,
});

function makeQueryChain(items: unknown[]) {
    const chain: Record<string, unknown> = {};
    const methods = ['eq', 'sort', 'limit', 'using', 'where', 'beginsWith'];
    for (const m of methods) chain[m] = vi.fn(() => chain);
    chain.exec = vi.fn().mockResolvedValue({ toJSON: () => items });
    return chain;
}

describe('ScheduledTaskDynamoRepository', () => {
    let repo: ScheduledTaskDynamoRepository;

    beforeEach(() => {
        repo = new ScheduledTaskDynamoRepository();
        vi.clearAllMocks();
    });

    describe('createScheduledTask', () => {
        it('creates task with generated taskId', async () => {
            vi.mocked(ScheduledTaskModel.create).mockResolvedValue(undefined as any);

            const result = await repo.createScheduledTask({
                tenantId: 't1',
                name: 'Daily Cleanup',
                description: 'Runs daily',
                cronExpression: '0 2 * * *',
                timezone: 'UTC',
                mode: 'plan',
                autoApprove: false,
                notification: { type: 'none' },
                createdBy: 'user-1',
            });

            expect(result.taskId).toBeTruthy();
            expect(result.taskStatus).toBe('active');
            expect(result.runCount).toBe(0);
            expect(ScheduledTaskModel.create).toHaveBeenCalledOnce();
        });
    });

    describe('listScheduledTasks', () => {
        it('excludes deleted tasks', async () => {
            const chain = makeQueryChain([
                makeTask({ taskStatus: 'active' }),
                makeTask({ taskId: 'task-2', taskStatus: 'deleted' }),
            ]);
            vi.mocked(ScheduledTaskModel.query).mockReturnValue(chain as any);

            const result = await repo.listScheduledTasks('t1');
            expect(result).toHaveLength(1);
            expect(result[0].taskStatus).toBe('active');
        });
    });

    describe('listAllActiveTasks', () => {
        it('returns only active tasks across all tenants', async () => {
            const chain = makeQueryChain([
                makeTask({ taskStatus: 'active' }),
                makeTask({ taskId: 'task-2', taskStatus: 'paused' }),
            ]);
            vi.mocked(ScheduledTaskModel.query).mockReturnValue(chain as any);

            const result = await repo.listAllActiveTasks();
            expect(result).toHaveLength(1);
            expect(result[0].taskStatus).toBe('active');
        });
    });

    describe('deleteScheduledTask', () => {
        it('soft-deletes by setting taskStatus=deleted', async () => {
            vi.mocked(ScheduledTaskModel.update).mockResolvedValue(undefined as any);

            await repo.deleteScheduledTask('t1', 'task-1');

            expect(ScheduledTaskModel.update).toHaveBeenCalledWith(
                expect.objectContaining({ PK: 'TENANT#t1', SK: 'SCHED#task-1' }),
                expect.objectContaining({ taskStatus: 'deleted' })
            );
        });
    });

    describe('updateLastRun', () => {
        it('increments runCount', async () => {
            vi.mocked(ScheduledTaskModel.get).mockResolvedValue({ toJSON: () => makeTask({ runCount: 3 }) } as any);
            vi.mocked(ScheduledTaskModel.update).mockResolvedValue(undefined as any);

            await repo.updateLastRun('t1', 'task-1', 'run-x', 'completed');

            const updateArg = vi.mocked(ScheduledTaskModel.update).mock.calls[0][1] as any;
            expect(updateArg.runCount).toBe(4);
        });
    });
});
