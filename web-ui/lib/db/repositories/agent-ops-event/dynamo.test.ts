import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/agent-ops/models/agent-ops-event', () => ({
    AgentOpsEventModel: {
        create: vi.fn(),
        query: vi.fn(),
    },
}));

vi.mock('@/lib/agent-ops/dynamoose-config', () => ({
    TTL_30_DAYS: vi.fn(() => Math.floor(Date.now() / 1000) + 30 * 24 * 3600),
}));

import { AgentOpsEventModel } from '@/lib/agent-ops/models/agent-ops-event';
import { AgentOpsEventDynamoRepository } from './dynamo';

function makeQueryChain(items: unknown[]) {
    const chain: Record<string, unknown> = {};
    const methods = ['eq', 'sort', 'limit', 'using', 'where', 'beginsWith'];
    for (const m of methods) chain[m] = vi.fn(() => chain);
    chain.exec = vi.fn().mockResolvedValue({ toJSON: () => items });
    return chain;
}

describe('AgentOpsEventDynamoRepository', () => {
    let repo: AgentOpsEventDynamoRepository;

    beforeEach(() => {
        repo = new AgentOpsEventDynamoRepository();
        vi.clearAllMocks();
    });

    describe('recordEvent', () => {
        it('creates event with PK=RUN#runId and does not throw on failure', async () => {
            vi.mocked(AgentOpsEventModel.create).mockResolvedValue(undefined as any);

            await expect(
                repo.recordEvent({ runId: 'run-1', eventType: 'planning', node: 'planner' })
            ).resolves.toBeUndefined();

            expect(AgentOpsEventModel.create).toHaveBeenCalledOnce();
            const arg = vi.mocked(AgentOpsEventModel.create).mock.calls[0][0] as any;
            expect(arg.PK).toBe('RUN#run-1');
            expect(arg.SK).toMatch(/^EVENT#/);
        });

        it('does not throw when create fails', async () => {
            vi.mocked(AgentOpsEventModel.create).mockRejectedValue(new Error('DynamoDB error'));

            await expect(
                repo.recordEvent({ runId: 'run-1', eventType: 'error', node: 'executor' })
            ).resolves.toBeUndefined();
        });
    });

    describe('getRunEvents', () => {
        it('queries PK=RUN#runId with SK beginsWith EVENT# in ascending order', async () => {
            const chain = makeQueryChain([]);
            vi.mocked(AgentOpsEventModel.query).mockReturnValue(chain as any);

            await repo.getRunEvents('run-1', 't1');

            expect(AgentOpsEventModel.query).toHaveBeenCalledWith('PK');
            expect(chain.eq).toHaveBeenCalledWith('RUN#run-1');
            expect(chain.sort).toHaveBeenCalledWith('ascending');
        });
    });
});
