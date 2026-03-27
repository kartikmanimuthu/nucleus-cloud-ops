import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockedFunction } from 'vitest';

vi.mock('@/lib/aws-config', () => ({
    getDynamoDBDocumentClient: vi.fn(),
    APP_TABLE_NAME: 'test-app-table',
    AUDIT_TABLE_NAME: 'test-audit-table',
    DEFAULT_TENANT_ID: 'org-default',
}));

import { getDynamoDBDocumentClient } from '@/lib/aws-config';
import { AuditLogDynamoRepository } from './dynamo';

describe('AuditLogDynamoRepository', () => {
    let repo: AuditLogDynamoRepository;
    let mockSend: MockedFunction<(...args: unknown[]) => unknown>;

    beforeEach(() => {
        mockSend = vi.fn();
        vi.mocked(getDynamoDBDocumentClient).mockReturnValue({ send: mockSend } as never);
        repo = new AuditLogDynamoRepository();
    });

    describe('createAuditLog', () => {
        it('sends PutCommand to AUDIT_TABLE_NAME (test-audit-table)', async () => {
            mockSend.mockResolvedValueOnce({});

            await repo.createAuditLog({
                eventType: 'account.create',
                action: 'Create Account',
                user: 'alice',
                userType: 'user',
                status: 'success',
                severity: 'info',
                resource: 'account-1',
                source: 'web-ui',
            });

            const sentCommand = mockSend.mock.calls[0][0] as {
                input: { TableName: string; Item: Record<string, unknown> }
            };
            expect(sentCommand.input.TableName).toBe('test-audit-table');
            expect(sentCommand.input.Item.pk).toMatch(/^LOG#/);
            expect(sentCommand.input.Item.gsi1pk).toBe('TYPE#LOG');
        });

        it('sets expire_at (TTL) approximately 30 days from now', async () => {
            mockSend.mockResolvedValueOnce({});

            const before = Math.floor(Date.now() / 1000);

            await repo.createAuditLog({
                eventType: 'schedule.delete',
                action: 'Delete Schedule',
                user: 'system',
                userType: 'system',
                status: 'success',
                severity: 'info',
                source: 'web-ui',
            });

            const after = Math.floor(Date.now() / 1000);
            const sentCommand = mockSend.mock.calls[0][0] as {
                input: { Item: Record<string, number> }
            };
            const expireAt = sentCommand.input.Item.expire_at;
            const thirtyDaySecs = 30 * 24 * 60 * 60;

            expect(expireAt).toBeGreaterThanOrEqual(before + thirtyDaySecs);
            expect(expireAt).toBeLessThanOrEqual(after + thirtyDaySecs + 1);
        });

        it('returns void (fire-and-forget) — does not throw on error', async () => {
            mockSend.mockRejectedValueOnce(new Error('DynamoDB unavailable'));

            // Should NOT throw — fire-and-forget pattern
            await expect(
                repo.createAuditLog({
                    eventType: 'audit.test',
                    action: 'Test',
                    user: 'system',
                    userType: 'system',
                    status: 'info',
                    severity: 'info',
                    source: 'web-ui',
                })
            ).resolves.toBeUndefined();
        });

        it('includes GSI2 USER# and GSI3 EVENT# keys for filtering', async () => {
            mockSend.mockResolvedValueOnce({});

            await repo.createAuditLog({
                eventType: 'schedule.update',
                action: 'Update Schedule',
                user: 'bob',
                userType: 'admin',
                status: 'success',
                severity: 'info',
                source: 'web-ui',
            });

            const sentCommand = mockSend.mock.calls[0][0] as {
                input: { Item: Record<string, string> }
            };
            expect(sentCommand.input.Item.gsi2pk).toBe('USER#bob');
            expect(sentCommand.input.Item.gsi3pk).toBe('EVENT#schedule.update');
        });
    });

    describe('getAuditLogs', () => {
        it('queries GSI1 with gsi1pk=TYPE#LOG for default case', async () => {
            mockSend.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });

            await repo.getAuditLogs('org-default');

            const sentCommand = mockSend.mock.calls[0][0] as {
                input: { IndexName: string; ExpressionAttributeValues: Record<string, string> }
            };
            expect(sentCommand.input.IndexName).toBe('GSI1');
            expect(sentCommand.input.ExpressionAttributeValues[':pkVal']).toBe('TYPE#LOG');
        });

        it('returns empty logs array when no items', async () => {
            mockSend.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });

            const result = await repo.getAuditLogs('org-default');

            expect(result.logs).toHaveLength(0);
            expect(result.nextPageToken).toBeUndefined();
        });
    });
});
