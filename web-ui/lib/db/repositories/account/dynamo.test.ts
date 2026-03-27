import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockedFunction } from 'vitest';

vi.mock('@/lib/aws-config', () => ({
    getDynamoDBDocumentClient: vi.fn(),
    APP_TABLE_NAME: 'test-table',
    DEFAULT_TENANT_ID: 'org-default',
}));

import { getDynamoDBDocumentClient } from '@/lib/aws-config';
import { AccountDynamoRepository } from './dynamo';

describe('AccountDynamoRepository', () => {
    let repo: AccountDynamoRepository;
    let mockSend: MockedFunction<(...args: unknown[]) => unknown>;

    beforeEach(() => {
        mockSend = vi.fn();
        vi.mocked(getDynamoDBDocumentClient).mockReturnValue({ send: mockSend } as never);
        repo = new AccountDynamoRepository();
    });

    describe('getAccounts', () => {
        it('returns accounts from GSI1 query result', async () => {
            mockSend.mockResolvedValueOnce({
                Items: [
                    {
                        accountId: 'acc-1',
                        accountName: 'Test Account',
                        active: true,
                        regions: ['us-east-1'],
                        roleArn: 'arn:aws:iam::123:role/test',
                        connectionStatus: 'connected',
                    },
                ],
                LastEvaluatedKey: undefined,
            });

            const result = await repo.getAccounts({ tenantId: 'org-default' });

            expect(result.accounts).toHaveLength(1);
            expect(result.accounts[0].name).toBe('Test Account');
            expect(result.accounts[0].accountId).toBe('acc-1');
            expect(result.totalCount).toBe(1);
        });

        it('paginates through multiple pages from DynamoDB', async () => {
            // First page with LastEvaluatedKey
            mockSend.mockResolvedValueOnce({
                Items: [{ accountId: 'acc-1', accountName: 'Account 1', active: true, regions: [], roleArn: '' }],
                LastEvaluatedKey: { pk: 'key' },
            });
            // Second page — no more pages
            mockSend.mockResolvedValueOnce({
                Items: [{ accountId: 'acc-2', accountName: 'Account 2', active: false, regions: [], roleArn: '' }],
                LastEvaluatedKey: undefined,
            });

            const result = await repo.getAccounts({ tenantId: 'org-default' });
            expect(result.accounts).toHaveLength(2);
            expect(result.totalCount).toBe(2);
            expect(mockSend).toHaveBeenCalledTimes(2);
        });

        it('filters by statusFilter in JS after fetching all records', async () => {
            mockSend.mockResolvedValueOnce({
                Items: [
                    { accountId: 'acc-1', accountName: 'Active Account', active: true, regions: [], roleArn: '' },
                    { accountId: 'acc-2', accountName: 'Inactive Account', active: false, regions: [], roleArn: '' },
                ],
                LastEvaluatedKey: undefined,
            });

            const result = await repo.getAccounts({ tenantId: 'org-default', statusFilter: 'active' });

            expect(result.accounts).toHaveLength(1);
            expect(result.accounts[0].accountId).toBe('acc-1');
            expect(result.totalCount).toBe(1);
        });

        it('returns empty accounts when no Items in response', async () => {
            mockSend.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });

            const result = await repo.getAccounts({ tenantId: 'org-default' });

            expect(result.accounts).toHaveLength(0);
            expect(result.totalCount).toBe(0);
        });
    });

    describe('getAccount', () => {
        it('returns null when Item is undefined', async () => {
            mockSend.mockResolvedValueOnce({ Item: undefined });

            const result = await repo.getAccount('acc-missing', 'org-default');

            expect(result).toBeNull();
        });

        it('returns UIAccount when Item found', async () => {
            mockSend.mockResolvedValueOnce({
                Item: {
                    accountId: 'acc-1',
                    accountName: 'My Account',
                    active: true,
                    regions: ['eu-west-1'],
                    roleArn: 'arn:aws:iam::456:role/test',
                    connectionStatus: 'unknown',
                },
            });

            const result = await repo.getAccount('acc-1', 'org-default');

            expect(result).not.toBeNull();
            expect(result!.accountId).toBe('acc-1');
            expect(result!.name).toBe('My Account');
            expect(result!.regions).toEqual(['eu-west-1']);
        });
    });

    describe('createAccount', () => {
        it('sends PutCommand with correct pk/sk format TENANT#tenantId / ACCOUNT#accountId', async () => {
            mockSend.mockResolvedValueOnce({});

            await repo.createAccount(
                {
                    accountId: 'acc-new',
                    name: 'New Account',
                    roleArn: 'arn:aws:iam::789:role/test',
                    regions: ['us-west-2'],
                    active: true,
                    description: 'Test',
                    connectionStatus: 'unknown',
                    resourceCount: 0,
                    schedulesCount: 0,
                    monthlySavings: 0,
                    tags: [],
                },
                'org-default'
            );

            const sentCommand = mockSend.mock.calls[0][0] as { input: { Item: Record<string, unknown> } };
            expect(sentCommand.input.Item.pk).toBe('TENANT#org-default');
            expect(sentCommand.input.Item.sk).toBe('ACCOUNT#acc-new');
            expect(sentCommand.input.Item.gsi1pk).toBe('TYPE#ACCOUNT');
        });

        it('returns UIAccount with correct shape after create', async () => {
            mockSend.mockResolvedValueOnce({});

            const result = await repo.createAccount(
                {
                    accountId: 'acc-ret',
                    name: 'Return Test',
                    roleArn: 'arn:aws:iam::000:role/test',
                    regions: ['ap-southeast-1'],
                    active: true,
                    description: '',
                    connectionStatus: 'unknown',
                    resourceCount: 0,
                    schedulesCount: 0,
                    monthlySavings: 0,
                    tags: [],
                },
                'org-default'
            );

            expect(result.accountId).toBe('acc-ret');
            expect(result.name).toBe('Return Test');
        });
    });

    describe('deleteAccount', () => {
        it('sends DeleteCommand with correct pk/sk keys', async () => {
            mockSend.mockResolvedValueOnce({});

            await repo.deleteAccount('acc-del', 'org-default');

            const sentCommand = mockSend.mock.calls[0][0] as { input: { Key: Record<string, unknown> } };
            expect(sentCommand.input.Key.pk).toBe('TENANT#org-default');
            expect(sentCommand.input.Key.sk).toBe('ACCOUNT#acc-del');
        });
    });
});
