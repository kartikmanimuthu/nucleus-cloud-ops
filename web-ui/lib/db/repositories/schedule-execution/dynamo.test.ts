import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockedFunction } from 'vitest';

vi.mock('@/lib/aws-config', () => ({
    getDynamoDBDocumentClient: vi.fn(),
    APP_TABLE_NAME: 'test-app-table',
    AUDIT_TABLE_NAME: 'test-audit-table',
    DEFAULT_TENANT_ID: 'org-default',
}));

import { getDynamoDBDocumentClient } from '@/lib/aws-config';
import { ScheduleExecutionDynamoRepository } from './dynamo';

describe('ScheduleExecutionDynamoRepository', () => {
    let repo: ScheduleExecutionDynamoRepository;
    let mockSend: MockedFunction<(...args: unknown[]) => unknown>;

    beforeEach(() => {
        mockSend = vi.fn();
        vi.mocked(getDynamoDBDocumentClient).mockReturnValue({ send: mockSend } as never);
        repo = new ScheduleExecutionDynamoRepository();
    });

    describe('logExecution', () => {
        it('sends PutCommand with correct pk=TENANT#...#SCHEDULE#... and sk=EXEC#...', async () => {
            mockSend.mockResolvedValueOnce({});

            await repo.logExecution({
                tenantId: 'org-default',
                accountId: 'acc-1',
                scheduleId: 'sched-123',
                executionTime: '2024-01-01T10:00:00.000Z',
                status: 'success',
                resourcesStarted: 3,
                resourcesStopped: 0,
                resourcesFailed: 0,
            });

            const sentCommand = mockSend.mock.calls[0][0] as {
                input: { Item: Record<string, string> }
            };
            expect(sentCommand.input.Item.pk).toBe('TENANT#org-default#SCHEDULE#sched-123');
            expect(sentCommand.input.Item.sk).toMatch(/^EXEC#/);
            expect(sentCommand.input.Item.executionId).toMatch(/^exec-/);
        });

        it('includes GSI1 keys for TYPE#EXECUTION listing', async () => {
            mockSend.mockResolvedValueOnce({});

            await repo.logExecution({
                tenantId: 'org-default',
                accountId: 'acc-1',
                scheduleId: 'sched-456',
                executionTime: new Date().toISOString(),
                status: 'failed',
                resourcesStarted: 0,
                resourcesStopped: 0,
                resourcesFailed: 2,
            });

            const sentCommand = mockSend.mock.calls[0][0] as {
                input: { Item: Record<string, string> }
            };
            expect(sentCommand.input.Item.gsi1pk).toBe('TYPE#EXECUTION');
            expect(sentCommand.input.Item.gsi1sk).toBeDefined();
        });

        it('returns ScheduleExecution object with generated executionId', async () => {
            mockSend.mockResolvedValueOnce({});

            const result = await repo.logExecution({
                tenantId: 'org-default',
                accountId: 'acc-1',
                scheduleId: 'sched-789',
                executionTime: '2024-02-01T12:00:00.000Z',
                status: 'success',
            });

            expect(result.executionId).toMatch(/^exec-/);
            expect(result.scheduleId).toBe('sched-789');
            expect(result.status).toBe('success');
        });
    });

    describe('getExecutionHistory', () => {
        it('queries by pk=TENANT#...#SCHEDULE#... with sk begins_with EXEC#', async () => {
            mockSend.mockResolvedValueOnce({ Items: [] });

            await repo.getExecutionHistory('sched-123', 'org-default', 20);

            const sentCommand = mockSend.mock.calls[0][0] as {
                input: {
                    KeyConditionExpression: string;
                    ExpressionAttributeValues: Record<string, string>;
                    Limit: number;
                }
            };
            expect(sentCommand.input.ExpressionAttributeValues[':pk']).toBe(
                'TENANT#org-default#SCHEDULE#sched-123'
            );
            expect(sentCommand.input.ExpressionAttributeValues[':skPrefix']).toBe('EXEC#');
            expect(sentCommand.input.Limit).toBe(20);
        });

        it('returns mapped UIScheduleExecution array', async () => {
            mockSend.mockResolvedValueOnce({
                Items: [
                    {
                        executionId: 'exec-001',
                        tenantId: 'org-default',
                        accountId: 'acc-1',
                        scheduleId: 'sched-123',
                        executionTime: '2024-01-01T10:00:00Z',
                        status: 'success',
                        resourcesStarted: 2,
                        resourcesStopped: 0,
                        resourcesFailed: 0,
                    },
                ],
            });

            const result = await repo.getExecutionHistory('sched-123', 'org-default');

            expect(result).toHaveLength(1);
            expect(result[0].id).toBe('exec-001');
            expect(result[0].status).toBe('success');
        });
    });

    describe('getRecentExecutions', () => {
        it('queries GSI1 with gsi1pk=TYPE#EXECUTION', async () => {
            mockSend.mockResolvedValueOnce({ Items: [] });

            await repo.getRecentExecutions('org-default', 50);

            const sentCommand = mockSend.mock.calls[0][0] as {
                input: {
                    IndexName: string;
                    ExpressionAttributeValues: Record<string, string>;
                    Limit: number;
                }
            };
            expect(sentCommand.input.IndexName).toBe('GSI1');
            expect(sentCommand.input.ExpressionAttributeValues[':pkVal']).toBe('TYPE#EXECUTION');
            expect(sentCommand.input.Limit).toBe(50);
        });

        it('returns mapped UIScheduleExecution array for recent executions', async () => {
            mockSend.mockResolvedValueOnce({
                Items: [
                    {
                        executionId: 'exec-latest',
                        tenantId: 'org-default',
                        accountId: 'acc-2',
                        scheduleId: 'sched-999',
                        executionTime: '2024-03-01T08:00:00Z',
                        status: 'partial',
                        resourcesStarted: 1,
                        resourcesStopped: 0,
                        resourcesFailed: 1,
                    },
                ],
            });

            const result = await repo.getRecentExecutions('org-default');

            expect(result).toHaveLength(1);
            expect(result[0].id).toBe('exec-latest');
            expect(result[0].status).toBe('partial');
        });
    });
});
