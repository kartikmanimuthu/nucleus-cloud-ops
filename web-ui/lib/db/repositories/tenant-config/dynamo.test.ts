import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TenantConfigDynamoRepository } from './dynamo';

// Mock the DynamoDB client module
vi.mock('@/lib/aws-config', () => ({
    getDynamoDBDocumentClient: vi.fn(),
    APP_TABLE_NAME: 'test-app-table',
    DEFAULT_TENANT_ID: 'default-tenant',
}));

import { getDynamoDBDocumentClient } from '@/lib/aws-config';

describe('TenantConfigDynamoRepository', () => {
    let repo: TenantConfigDynamoRepository;
    let mockSend: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        mockSend = vi.fn();
        vi.mocked(getDynamoDBDocumentClient).mockReturnValue({ send: mockSend } as never);
        repo = new TenantConfigDynamoRepository();
    });

    describe('getConfig', () => {
        it('returns data when Item found', async () => {
            mockSend.mockResolvedValueOnce({ Item: { data: { theme: 'dark' } } });
            const result = await repo.getConfig<{ theme: string }>('theme', 'tenant-1');
            expect(result).toEqual({ theme: 'dark' });
        });

        it('returns null when no Item', async () => {
            mockSend.mockResolvedValueOnce({ Item: undefined });
            const result = await repo.getConfig('missing-key', 'tenant-1');
            expect(result).toBeNull();
        });
    });

    describe('saveConfig', () => {
        it('sends PutCommand with correct PK/SK pattern', async () => {
            mockSend.mockResolvedValueOnce({});
            await repo.saveConfig('theme', { theme: 'dark' }, 'tenant-1');
            const sentCommand = mockSend.mock.calls[0][0];
            expect(sentCommand.input.Item.pk).toBe('TENANT#tenant-1');
            expect(sentCommand.input.Item.sk).toBe('CONFIG#theme');
        });

        it('sets gsi1pk to TYPE#CONFIG', async () => {
            mockSend.mockResolvedValueOnce({});
            await repo.saveConfig('theme', {}, 'tenant-1');
            const sentCommand = mockSend.mock.calls[0][0];
            expect(sentCommand.input.Item.gsi1pk).toBe('TYPE#CONFIG');
        });

        it('defaults updatedBy to system', async () => {
            mockSend.mockResolvedValueOnce({});
            await repo.saveConfig('theme', {}, 'tenant-1');
            const sentCommand = mockSend.mock.calls[0][0];
            expect(sentCommand.input.Item.updatedBy).toBe('system');
        });
    });

    describe('deleteConfig', () => {
        it('sends DeleteCommand with correct PK+SK', async () => {
            mockSend.mockResolvedValueOnce({});
            await repo.deleteConfig('theme', 'tenant-1');
            const sentCommand = mockSend.mock.calls[0][0];
            expect(sentCommand.input.Key.pk).toBe('TENANT#tenant-1');
            expect(sentCommand.input.Key.sk).toBe('CONFIG#theme');
        });
    });

    describe('listConfigs', () => {
        it('returns mapped configKey and updatedAt', async () => {
            mockSend.mockResolvedValueOnce({
                Items: [
                    { configKey: 'theme', updatedAt: '2025-01-01T00:00:00.000Z' },
                    { configKey: 'locale', updatedAt: '2025-01-02T00:00:00.000Z' },
                ],
            });
            const result = await repo.listConfigs('tenant-1');
            expect(result).toHaveLength(2);
            expect(result[0]).toEqual({ configKey: 'theme', updatedAt: '2025-01-01T00:00:00.000Z' });
        });

        it('queries with CONFIG# sk prefix', async () => {
            mockSend.mockResolvedValueOnce({ Items: [] });
            await repo.listConfigs('tenant-1');
            const sentCommand = mockSend.mock.calls[0][0];
            expect(sentCommand.input.ExpressionAttributeValues[':skPrefix']).toBe('CONFIG#');
        });
    });
});
