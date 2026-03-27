import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockedFunction } from 'vitest';

vi.mock('@/lib/aws-config', () => ({
    getDynamoDBDocumentClient: vi.fn(),
    APP_TABLE_NAME: 'test-table',
    DEFAULT_TENANT_ID: 'org-default',
}));

import { getDynamoDBDocumentClient } from '@/lib/aws-config';
import { RbacDynamoRepository } from './dynamo';

describe('RbacDynamoRepository', () => {
    let repo: RbacDynamoRepository;
    let mockSend: MockedFunction<(...args: unknown[]) => unknown>;

    beforeEach(() => {
        mockSend = vi.fn();
        vi.mocked(getDynamoDBDocumentClient).mockReturnValue({ send: mockSend } as never);
        repo = new RbacDynamoRepository();
    });

    describe('getUserTenantRole', () => {
        it('sends GetCommand with PK=USER#{userId} SK=TENANT#{tenantId}', async () => {
            mockSend.mockResolvedValueOnce({ Item: { role: 'admin' } });

            await repo.getUserTenantRole('user-123', 'tenant-456');

            const sentCommand = mockSend.mock.calls[0][0] as { input: { Key: Record<string, unknown> } };
            expect(sentCommand.input.Key.PK).toBe('USER#user-123');
            expect(sentCommand.input.Key.SK).toBe('TENANT#tenant-456');
        });

        it('returns role string when Item found', async () => {
            mockSend.mockResolvedValueOnce({ Item: { role: 'editor' } });

            const result = await repo.getUserTenantRole('user-1', 'tenant-1');

            expect(result).toBe('editor');
        });

        it('returns null when Item is undefined', async () => {
            mockSend.mockResolvedValueOnce({ Item: undefined });

            const result = await repo.getUserTenantRole('user-missing', 'tenant-1');

            expect(result).toBeNull();
        });
    });

    describe('getUserAllRoles', () => {
        it('queries with PK=USER#{userId} and begins_with SK prefix TENANT#', async () => {
            mockSend.mockResolvedValueOnce({ Items: [] });

            await repo.getUserAllRoles('user-all-roles');

            const sentCommand = mockSend.mock.calls[0][0] as {
                input: { ExpressionAttributeValues: Record<string, unknown> };
            };
            expect(sentCommand.input.ExpressionAttributeValues[':pk']).toBe('USER#user-all-roles');
            expect(sentCommand.input.ExpressionAttributeValues[':sk']).toBe('TENANT#');
        });

        it('returns empty array when no Items', async () => {
            mockSend.mockResolvedValueOnce({ Items: undefined });

            const result = await repo.getUserAllRoles('user-x');

            expect(result).toEqual([]);
        });
    });

    describe('assignUserRole', () => {
        it('sends PutCommand with correct EntityType=UserTenantRole field', async () => {
            mockSend.mockResolvedValueOnce({});

            await repo.assignUserRole('user-1', 'user@example.com', 'tenant-1', 'admin', 'admin@example.com');

            const sentCommand = mockSend.mock.calls[0][0] as { input: { Item: Record<string, unknown> } };
            expect(sentCommand.input.Item.EntityType).toBe('UserTenantRole');
            expect(sentCommand.input.Item.PK).toBe('USER#user-1');
            expect(sentCommand.input.Item.SK).toBe('TENANT#tenant-1');
            expect(sentCommand.input.Item.role).toBe('admin');
            expect(sentCommand.input.Item.email).toBe('user@example.com');
        });

        it('includes assignedBy in PutCommand item', async () => {
            mockSend.mockResolvedValueOnce({});

            await repo.assignUserRole('user-2', 'u2@example.com', 'tenant-2', 'viewer', 'assigner@example.com');

            const sentCommand = mockSend.mock.calls[0][0] as { input: { Item: Record<string, unknown> } };
            expect(sentCommand.input.Item.assignedBy).toBe('assigner@example.com');
        });
    });

    describe('getTenantUsers', () => {
        it('sends QueryCommand on EntityTypeIndex with EntityType=UserTenantRole', async () => {
            mockSend.mockResolvedValueOnce({ Items: [] });

            await repo.getTenantUsers('tenant-abc');

            const sentCommand = mockSend.mock.calls[0][0] as {
                input: {
                    IndexName: string;
                    ExpressionAttributeValues: Record<string, unknown>;
                    FilterExpression: string;
                };
            };
            expect(sentCommand.input.IndexName).toBe('EntityTypeIndex');
            expect(sentCommand.input.ExpressionAttributeValues[':entityType']).toBe('UserTenantRole');
            expect(sentCommand.input.ExpressionAttributeValues[':tenantId']).toBe('tenant-abc');
        });

        it('returns empty array when Items is undefined', async () => {
            mockSend.mockResolvedValueOnce({ Items: undefined });

            const result = await repo.getTenantUsers('tenant-empty');

            expect(result).toEqual([]);
        });
    });
});
