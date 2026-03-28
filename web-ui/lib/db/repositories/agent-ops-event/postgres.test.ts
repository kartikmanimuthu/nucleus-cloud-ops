import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockedFunction } from 'vitest';

vi.mock('@/lib/db/pg-config', () => ({
    getPrismaClient: vi.fn(),
}));

import { getPrismaClient } from '@/lib/db/pg-config';
import { AgentOpsEventPostgresRepository } from './postgres';

const makeEventRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'cuid-1',
    tenantId: 't1',
    runId: 'run-1',
    eventType: 'planning',
    node: 'planner',
    content: 'Planning step',
    toolName: null,
    toolArgs: null,
    toolOutput: null,
    metadata: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    expiresAt: new Date('2024-02-01T00:00:00Z'),
    ...overrides,
});

describe('AgentOpsEventPostgresRepository', () => {
    let mockPrisma: {
        agentOpsEvent: {
            create: MockedFunction<any>;
            findMany: MockedFunction<any>;
        };
    };

    beforeEach(() => {
        mockPrisma = {
            agentOpsEvent: {
                create: vi.fn(),
                findMany: vi.fn(),
            },
        };
        vi.mocked(getPrismaClient).mockReturnValue(mockPrisma as any);
    });

    describe('recordEvent', () => {
        it('creates event and does not throw on success', async () => {
            mockPrisma.agentOpsEvent.create.mockResolvedValue(makeEventRow());

            const repo = new AgentOpsEventPostgresRepository();
            await expect(
                repo.recordEvent({ runId: 'run-1', eventType: 'planning', node: 'planner' })
            ).resolves.toBeUndefined();

            expect(mockPrisma.agentOpsEvent.create).toHaveBeenCalledOnce();
        });

        it('does not throw when create fails', async () => {
            mockPrisma.agentOpsEvent.create.mockRejectedValue(new Error('DB error'));

            const repo = new AgentOpsEventPostgresRepository();
            await expect(
                repo.recordEvent({ runId: 'run-1', eventType: 'error', node: 'executor' })
            ).resolves.toBeUndefined();
        });
    });

    describe('getRunEvents', () => {
        it('returns events in chronological order (createdAt ASC)', async () => {
            const events = [
                makeEventRow({ createdAt: new Date('2024-01-01T00:00:00Z') }),
                makeEventRow({ id: 'cuid-2', createdAt: new Date('2024-01-01T00:01:00Z'), eventType: 'execution' }),
            ];
            mockPrisma.agentOpsEvent.findMany.mockResolvedValue(events);

            const repo = new AgentOpsEventPostgresRepository();
            const result = await repo.getRunEvents('run-1', 't1');

            expect(mockPrisma.agentOpsEvent.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({ runId: 'run-1', tenantId: 't1' }),
                    orderBy: { createdAt: 'asc' },
                })
            );
            expect(result).toHaveLength(2);
        });

        it('enforces cross-tenant isolation via tenantId in WHERE', async () => {
            mockPrisma.agentOpsEvent.findMany.mockResolvedValue([]);

            const repo = new AgentOpsEventPostgresRepository();
            await repo.getRunEvents('run-1', 'other-tenant');

            const callArg = mockPrisma.agentOpsEvent.findMany.mock.calls[0][0];
            expect(callArg.where.tenantId).toBe('other-tenant');
        });
    });
});
