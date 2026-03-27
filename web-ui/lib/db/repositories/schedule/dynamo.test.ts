import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockedFunction } from 'vitest';

vi.mock('@/lib/aws-config', () => ({
    getDynamoDBDocumentClient: vi.fn(),
    APP_TABLE_NAME: 'test-app-table',
    AUDIT_TABLE_NAME: 'test-audit-table',
    DEFAULT_TENANT_ID: 'org-default',
}));

import { getDynamoDBDocumentClient } from '@/lib/aws-config';
import { ScheduleDynamoRepository } from './dynamo';

describe('ScheduleDynamoRepository', () => {
    let repo: ScheduleDynamoRepository;
    let mockSend: MockedFunction<(...args: unknown[]) => unknown>;

    beforeEach(() => {
        mockSend = vi.fn();
        vi.mocked(getDynamoDBDocumentClient).mockReturnValue({ send: mockSend } as never);
        repo = new ScheduleDynamoRepository();
    });

    describe('getSchedules', () => {
        it('sends QueryCommand with GSI1 pk=TYPE#SCHEDULE', async () => {
            mockSend.mockResolvedValueOnce({ Items: [] });

            await repo.getSchedules({ tenantId: 'org-default' });

            const sentCommand = mockSend.mock.calls[0][0] as {
                input: { IndexName: string; KeyConditionExpression: string; ExpressionAttributeValues: Record<string, string> }
            };
            expect(sentCommand.input.IndexName).toBe('GSI1');
            expect(sentCommand.input.KeyConditionExpression).toContain('gsi1pk');
            expect(sentCommand.input.ExpressionAttributeValues[':typeVal']).toBe('TYPE#SCHEDULE');
        });

        it('returns all schedules when no statusFilter applied', async () => {
            mockSend.mockResolvedValueOnce({
                Items: [
                    { scheduleId: 'sched-1', name: 'Morning Shutdown', active: true, days: ['Mon'], starttime: '08:00', endtime: '18:00', timezone: 'UTC', accounts: [], resources: [] },
                    { scheduleId: 'sched-2', name: 'Weekend Stop', active: false, days: ['Sat'], starttime: '00:00', endtime: '23:59', timezone: 'UTC', accounts: [], resources: [] },
                ],
            });

            const result = await repo.getSchedules({ tenantId: 'org-default' });

            expect(result.schedules).toHaveLength(2);
            expect(result.total).toBe(2);
        });

        it('filters active schedules in-memory when statusFilter=active', async () => {
            mockSend.mockResolvedValueOnce({
                Items: [
                    { scheduleId: 'sched-1', name: 'Active', active: true, days: [], starttime: '08:00', endtime: '18:00', timezone: 'UTC' },
                    { scheduleId: 'sched-2', name: 'Inactive', active: false, days: [], starttime: '08:00', endtime: '18:00', timezone: 'UTC' },
                ],
            });

            const result = await repo.getSchedules({ tenantId: 'org-default', statusFilter: 'active' });

            expect(result.schedules).toHaveLength(1);
            expect(result.schedules[0].id).toBe('sched-1');
            expect(result.total).toBe(1);
        });

        it('filters by searchTerm case-insensitively', async () => {
            mockSend.mockResolvedValueOnce({
                Items: [
                    { scheduleId: 'sched-1', name: 'Morning Shutdown', active: true, days: [], starttime: '08:00', endtime: '18:00', timezone: 'UTC' },
                    { scheduleId: 'sched-2', name: 'Weekend Stop', active: true, days: [], starttime: '08:00', endtime: '18:00', timezone: 'UTC' },
                ],
            });

            const result = await repo.getSchedules({ tenantId: 'org-default', searchTerm: 'morning' });

            expect(result.schedules).toHaveLength(1);
            expect(result.schedules[0].name).toBe('Morning Shutdown');
        });

        it('returns empty schedules when no Items', async () => {
            mockSend.mockResolvedValueOnce({ Items: [] });

            const result = await repo.getSchedules({ tenantId: 'org-default' });

            expect(result.schedules).toHaveLength(0);
            expect(result.total).toBe(0);
        });
    });

    describe('getSchedule', () => {
        it('sends GetCommand with correct pk/sk when accountId and UUID provided', async () => {
            mockSend.mockResolvedValueOnce({
                Item: {
                    scheduleId: 'sched-abc',
                    name: 'My Schedule',
                    active: true,
                    days: [],
                    starttime: '08:00',
                    endtime: '18:00',
                    timezone: 'UTC',
                    accountId: 'acc-1',
                },
            });

            const result = await repo.getSchedule('sched-abc', 'acc-1', 'org-default');

            const sentCommand = mockSend.mock.calls[0][0] as {
                input: { Key: Record<string, string> }
            };
            expect(sentCommand.input.Key.pk).toBe('TENANT#org-default#ACCOUNT#acc-1');
            expect(sentCommand.input.Key.sk).toBe('SCHEDULE#sched-abc');
            expect(result).not.toBeNull();
            expect(result!.id).toBe('sched-abc');
        });

        it('returns null when item not found', async () => {
            // getSchedule('sched-not-found') — UUID format triggers strategy 2 (2 parallel GSI3 queries)
            // Both return empty, then falls through to strategy 3 (GSI1 query by name)
            mockSend.mockResolvedValueOnce({ Items: [] }); // GSI3 STATUS#active
            mockSend.mockResolvedValueOnce({ Items: [] }); // GSI3 STATUS#inactive
            mockSend.mockResolvedValueOnce({ Items: [] }); // GSI1 fallback by name

            const result = await repo.getSchedule('sched-not-found');

            expect(result).toBeNull();
        });
    });

    describe('createSchedule', () => {
        it('sends PutCommand with correct pk/sk/GSI1 structure', async () => {
            mockSend.mockResolvedValueOnce({});

            await repo.createSchedule(
                {
                    name: 'Test Schedule',
                    active: true,
                    days: ['Mon', 'Tue'],
                    starttime: '09:00',
                    endtime: '17:00',
                    timezone: 'UTC',
                    accounts: ['acc-123'],
                    resourceTypes: [],
                    description: '',
                    executionCount: 0,
                    successRate: 100,
                    estimatedSavings: 0,
                },
                'org-default'
            );

            const sentCommand = mockSend.mock.calls[0][0] as {
                input: { Item: Record<string, string> }
            };
            expect(sentCommand.input.Item.pk).toMatch(/^TENANT#org-default#ACCOUNT#acc-123$/);
            expect(sentCommand.input.Item.sk).toMatch(/^SCHEDULE#sched-/);
            expect(sentCommand.input.Item.gsi1pk).toBe('TYPE#SCHEDULE');
        });

        it('throws if no accountId provided', async () => {
            await expect(
                repo.createSchedule(
                    {
                        name: 'No Account',
                        active: true,
                        days: [],
                        starttime: '09:00',
                        endtime: '17:00',
                        timezone: 'UTC',
                        accounts: [], // No accountId
                        resourceTypes: [],
                        description: '',
                        executionCount: 0,
                        successRate: 100,
                        estimatedSavings: 0,
                    },
                    'org-default'
                )
            ).rejects.toThrow('accountId is required');
        });
    });

    describe('updateSchedule', () => {
        it('sends UpdateCommand and returns updated UISchedule', async () => {
            // First call: getSchedule → sends GetCommand
            mockSend.mockResolvedValueOnce({
                Item: {
                    scheduleId: 'sched-1',
                    name: 'Old Name',
                    active: false,
                    days: [],
                    starttime: '08:00',
                    endtime: '17:00',
                    timezone: 'UTC',
                    accountId: 'acc-1',
                },
            });
            // Second call: UpdateCommand
            mockSend.mockResolvedValueOnce({
                Attributes: {
                    scheduleId: 'sched-1',
                    name: 'Old Name',
                    active: true,
                    days: [],
                    starttime: '08:00',
                    endtime: '17:00',
                    timezone: 'UTC',
                    accountId: 'acc-1',
                },
            });

            const result = await repo.updateSchedule('sched-1', { active: true }, 'org-default', 'acc-1');

            expect(result.active).toBe(true);
            expect(mockSend).toHaveBeenCalledTimes(2);
        });
    });

    describe('deleteSchedule', () => {
        it('sends DeleteCommand with correct pk/sk keys', async () => {
            // First call: getSchedule → returns item
            mockSend.mockResolvedValueOnce({
                Item: {
                    scheduleId: 'sched-del',
                    name: 'To Delete',
                    active: true,
                    days: [],
                    starttime: '08:00',
                    endtime: '17:00',
                    timezone: 'UTC',
                    accountId: 'acc-1',
                },
            });
            // Second call: DeleteCommand
            mockSend.mockResolvedValueOnce({});

            await repo.deleteSchedule('sched-del', 'org-default', 'acc-1');

            // DeleteCommand is the second call
            const deleteCommand = mockSend.mock.calls[1][0] as {
                input: { Key: Record<string, string> }
            };
            expect(deleteCommand.input.Key.pk).toBe('TENANT#org-default#ACCOUNT#acc-1');
            expect(deleteCommand.input.Key.sk).toBe('SCHEDULE#sched-del');
        });
    });
});
