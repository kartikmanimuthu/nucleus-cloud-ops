import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockedFunction } from 'vitest';

vi.mock('@/lib/aws-config', () => ({
    getDynamoDBDocumentClient: vi.fn(),
    APP_TABLE_NAME: 'test-app-table',
    DEFAULT_TENANT_ID: 'org-default',
}));

import { getDynamoDBDocumentClient } from '@/lib/aws-config';
import { DataSourceDynamoRepository } from './dynamo';

describe('DataSourceDynamoRepository', () => {
    let repo: DataSourceDynamoRepository;
    let mockSend: MockedFunction<(...args: unknown[]) => unknown>;

    beforeEach(() => {
        mockSend = vi.fn();
        vi.mocked(getDynamoDBDocumentClient).mockReturnValue({ send: mockSend } as never);
        repo = new DataSourceDynamoRepository();
    });

    describe('listDataSources', () => {
        it('sends QueryCommand with KB# pk and DATASOURCE# sk prefix', async () => {
            mockSend.mockResolvedValueOnce({ Items: [] });

            await repo.listDataSources('kb-1', 'tenant-1');

            const cmd = mockSend.mock.calls[0][0] as { input: Record<string, unknown> };
            expect(cmd.input.ExpressionAttributeValues).toMatchObject({
                ':pk': 'KB#kb-1',
                ':skPrefix': 'DATASOURCE#',
            });
        });

        it('returns mapped DataSource array', async () => {
            mockSend.mockResolvedValueOnce({
                Items: [
                    { id: 'ds-1', knowledgeBaseId: 'kb-1', name: 'My DS', sourceType: 'file-upload', status: 'pending', config: {}, vectorCount: 0, vectorKeys: [], createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' },
                ],
            });

            const result = await repo.listDataSources('kb-1', 'tenant-1');

            expect(result).toHaveLength(1);
            expect(result[0].id).toBe('ds-1');
            expect(result[0].knowledgeBaseId).toBe('kb-1');
        });
    });

    describe('getDataSource', () => {
        it('sends GetCommand with KB# pk and DATASOURCE# sk', async () => {
            mockSend.mockResolvedValueOnce({ Item: { id: 'ds-1', knowledgeBaseId: 'kb-1', name: 'DS', sourceType: 'file-upload', status: 'pending', config: {}, vectorCount: 0, vectorKeys: [], createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' } });

            await repo.getDataSource('kb-1', 'ds-1', 'tenant-1');

            const cmd = mockSend.mock.calls[0][0] as { input: { Key: Record<string, string> } };
            expect(cmd.input.Key.pk).toBe('KB#kb-1');
            expect(cmd.input.Key.sk).toBe('DATASOURCE#ds-1');
        });

        it('returns null when not found', async () => {
            mockSend.mockResolvedValueOnce({ Item: undefined });
            const result = await repo.getDataSource('kb-1', 'ds-missing', 'tenant-1');
            expect(result).toBeNull();
        });
    });

    describe('createDataSource', () => {
        it('sends PutCommand with KB# pk, DATASOURCE# sk, vectorCount=0, status=pending', async () => {
            mockSend.mockResolvedValueOnce({});

            const result = await repo.createDataSource(
                'kb-1',
                { name: 'New DS', sourceType: 'file-upload', config: { fileName: 'test.pdf', fileSize: 1024, mimeType: 'application/pdf', s3Key: 'key', chunkCount: 5 } },
                'tenant-1'
            );

            const cmd = mockSend.mock.calls[0][0] as { input: { Item: Record<string, unknown> } };
            expect(cmd.input.Item.pk).toBe('KB#kb-1');
            expect(cmd.input.Item.sk).toMatch(/^DATASOURCE#/);
            expect(cmd.input.Item.vectorCount).toBe(0);
            expect(cmd.input.Item.status).toBe('pending');
            expect(result.id).toBeDefined();
            expect(result.vectorKeys).toEqual([]);
        });
    });

    describe('updateDataSource', () => {
        it('sends UpdateCommand with correct key', async () => {
            mockSend.mockResolvedValueOnce({});

            await repo.updateDataSource('kb-1', 'ds-1', { status: 'synced' }, 'tenant-1');

            const cmd = mockSend.mock.calls[0][0] as { input: { Key: Record<string, string> } };
            expect(cmd.input.Key.pk).toBe('KB#kb-1');
            expect(cmd.input.Key.sk).toBe('DATASOURCE#ds-1');
        });

        it('only updates allowed fields', async () => {
            mockSend.mockResolvedValueOnce({});

            await repo.updateDataSource('kb-1', 'ds-1', { status: 'synced', vectorCount: 10, vectorKeys: ['key1'] }, 'tenant-1');

            const cmd = mockSend.mock.calls[0][0] as { input: { ExpressionAttributeValues: Record<string, unknown> } };
            expect(cmd.input.ExpressionAttributeValues[':status']).toBe('synced');
            expect(cmd.input.ExpressionAttributeValues[':vectorCount']).toBe(10);
            expect(cmd.input.ExpressionAttributeValues[':vectorKeys']).toEqual(['key1']);
        });
    });

    describe('deleteDataSource', () => {
        it('sends DeleteCommand with correct key', async () => {
            mockSend.mockResolvedValueOnce({});

            await repo.deleteDataSource('kb-1', 'ds-1', 'tenant-1');

            const cmd = mockSend.mock.calls[0][0] as { input: { Key: Record<string, string> } };
            expect(cmd.input.Key.pk).toBe('KB#kb-1');
            expect(cmd.input.Key.sk).toBe('DATASOURCE#ds-1');
        });
    });
});
