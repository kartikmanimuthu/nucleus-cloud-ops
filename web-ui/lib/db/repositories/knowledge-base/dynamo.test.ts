import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockedFunction } from 'vitest';

vi.mock('@/lib/aws-config', () => ({
    getDynamoDBDocumentClient: vi.fn(),
    APP_TABLE_NAME: 'test-app-table',
    DEFAULT_TENANT_ID: 'org-default',
}));

import { getDynamoDBDocumentClient } from '@/lib/aws-config';
import { KnowledgeBaseDynamoRepository } from './dynamo';

describe('KnowledgeBaseDynamoRepository', () => {
    let repo: KnowledgeBaseDynamoRepository;
    let mockSend: MockedFunction<(...args: unknown[]) => unknown>;

    beforeEach(() => {
        mockSend = vi.fn();
        vi.mocked(getDynamoDBDocumentClient).mockReturnValue({ send: mockSend } as never);
        repo = new KnowledgeBaseDynamoRepository();
    });

    describe('listKnowledgeBases', () => {
        it('sends QueryCommand with TENANT# pk and KB# sk prefix', async () => {
            mockSend.mockResolvedValueOnce({ Items: [] });

            await repo.listKnowledgeBases('tenant-1');

            const cmd = mockSend.mock.calls[0][0] as { input: Record<string, unknown> };
            expect(cmd.input.KeyConditionExpression).toContain('begins_with');
            expect(cmd.input.ExpressionAttributeValues).toMatchObject({
                ':pk': 'TENANT#tenant-1',
                ':skPrefix': 'KB#',
            });
        });

        it('returns mapped KnowledgeBase array', async () => {
            mockSend.mockResolvedValueOnce({
                Items: [
                    { id: 'kb-1', tenantId: 'tenant-1', name: 'My KB', status: 'active', vectorCount: 5, dataSourceCount: 2, createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' },
                ],
            });

            const result = await repo.listKnowledgeBases('tenant-1');

            expect(result).toHaveLength(1);
            expect(result[0].id).toBe('kb-1');
            expect(result[0].name).toBe('My KB');
        });

        it('returns empty array when no items', async () => {
            mockSend.mockResolvedValueOnce({ Items: [] });
            const result = await repo.listKnowledgeBases('tenant-1');
            expect(result).toHaveLength(0);
        });
    });

    describe('getKnowledgeBase', () => {
        it('sends GetCommand with correct pk/sk', async () => {
            mockSend.mockResolvedValueOnce({ Item: { id: 'kb-1', tenantId: 'tenant-1', name: 'KB', status: 'active', vectorCount: 0, dataSourceCount: 0, createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' } });

            await repo.getKnowledgeBase('kb-1', 'tenant-1');

            const cmd = mockSend.mock.calls[0][0] as { input: { Key: Record<string, string> } };
            expect(cmd.input.Key.pk).toBe('TENANT#tenant-1');
            expect(cmd.input.Key.sk).toBe('KB#kb-1');
        });

        it('returns null when item not found', async () => {
            mockSend.mockResolvedValueOnce({ Item: undefined });
            const result = await repo.getKnowledgeBase('kb-missing', 'tenant-1');
            expect(result).toBeNull();
        });

        it('returns KnowledgeBase when found', async () => {
            mockSend.mockResolvedValueOnce({
                Item: { id: 'kb-1', tenantId: 'tenant-1', name: 'Found KB', status: 'active', vectorCount: 3, dataSourceCount: 1, createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' },
            });

            const result = await repo.getKnowledgeBase('kb-1', 'tenant-1');
            expect(result).not.toBeNull();
            expect(result!.id).toBe('kb-1');
        });
    });

    describe('createKnowledgeBase', () => {
        it('sends PutCommand with correct pk/sk and returns KB with id', async () => {
            mockSend.mockResolvedValueOnce({});

            const result = await repo.createKnowledgeBase({ name: 'New KB', description: 'desc' }, 'tenant-1', 'user-1');

            const cmd = mockSend.mock.calls[0][0] as { input: { Item: Record<string, unknown> } };
            expect(cmd.input.Item.pk).toBe('TENANT#tenant-1');
            expect(cmd.input.Item.sk).toMatch(/^KB#/);
            expect(cmd.input.Item.name).toBe('New KB');
            expect(result.id).toBeDefined();
            expect(result.vectorCount).toBe(0);
            expect(result.dataSourceCount).toBe(0);
            expect(result.createdBy).toBe('user-1');
        });
    });

    describe('updateKnowledgeBase', () => {
        it('sends UpdateCommand with correct key', async () => {
            mockSend.mockResolvedValueOnce({});

            await repo.updateKnowledgeBase('kb-1', { name: 'Updated' }, 'tenant-1');

            const cmd = mockSend.mock.calls[0][0] as { input: { Key: Record<string, string> } };
            expect(cmd.input.Key.pk).toBe('TENANT#tenant-1');
            expect(cmd.input.Key.sk).toBe('KB#kb-1');
        });
    });

    describe('deleteKnowledgeBase', () => {
        it('sends DeleteCommand with correct key', async () => {
            mockSend.mockResolvedValueOnce({});

            await repo.deleteKnowledgeBase('kb-1', 'tenant-1');

            const cmd = mockSend.mock.calls[0][0] as { input: { Key: Record<string, string> } };
            expect(cmd.input.Key.pk).toBe('TENANT#tenant-1');
            expect(cmd.input.Key.sk).toBe('KB#kb-1');
        });
    });

    describe('updateDataSourceCount', () => {
        it('sends UpdateCommand with atomic increment expression', async () => {
            mockSend.mockResolvedValueOnce({});

            await repo.updateDataSourceCount('kb-1', 1, 'tenant-1');

            const cmd = mockSend.mock.calls[0][0] as { input: { UpdateExpression: string; ExpressionAttributeValues: Record<string, unknown> } };
            expect(cmd.input.UpdateExpression).toContain('dataSourceCount');
            expect(cmd.input.ExpressionAttributeValues[':delta']).toBe(1);
        });

        it('supports negative delta for decrement', async () => {
            mockSend.mockResolvedValueOnce({});

            await repo.updateDataSourceCount('kb-1', -1, 'tenant-1');

            const cmd = mockSend.mock.calls[0][0] as { input: { ExpressionAttributeValues: Record<string, unknown> } };
            expect(cmd.input.ExpressionAttributeValues[':delta']).toBe(-1);
        });
    });

    describe('updateVectorCount', () => {
        it('sends UpdateCommand with atomic increment expression for vectorCount', async () => {
            mockSend.mockResolvedValueOnce({});

            await repo.updateVectorCount('kb-1', 10, 'tenant-1');

            const cmd = mockSend.mock.calls[0][0] as { input: { UpdateExpression: string; ExpressionAttributeValues: Record<string, unknown> } };
            expect(cmd.input.UpdateExpression).toContain('vectorCount');
            expect(cmd.input.ExpressionAttributeValues[':delta']).toBe(10);
        });
    });
});
