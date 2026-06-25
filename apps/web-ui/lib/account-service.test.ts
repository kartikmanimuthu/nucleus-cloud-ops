import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the repository factory before importing AccountService
vi.mock('@/lib/db/repository-factory', () => ({
    getAccountRepository: vi.fn(),
}));

// Mock AuditService
vi.mock('@/lib/audit-service', () => ({
    AuditService: {
        logUserAction: vi.fn().mockResolvedValue(undefined),
    },
}));

import { getAccountRepository } from '@/lib/db/repository-factory';
import { AuditService } from '@/lib/audit-service';
import { AccountService } from './account-service';

const makeAccount = (overrides: Record<string, unknown> = {}) => ({
    id: 'acc-1',
    accountId: 'acc-1',
    name: 'Test Account',
    roleArn: 'arn:aws:iam::123456789012:role/NucleusRole',
    regions: ['us-east-1'],
    active: true,
    connectionStatus: 'connected' as const,
    description: '',
    resourceCount: 0,
    schedulesCount: 0,
    monthlySavings: 0,
    tags: [],
    lastValidated: '',
    createdBy: 'alice',
    updatedBy: 'alice',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-02T00:00:00Z',
    ...overrides,
});

describe('AccountService', () => {
    let mockRepo: {
        getAccounts: ReturnType<typeof vi.fn>;
        getAccount: ReturnType<typeof vi.fn>;
        createAccount: ReturnType<typeof vi.fn>;
        updateAccount: ReturnType<typeof vi.fn>;
        deleteAccount: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mockRepo = {
            getAccounts: vi.fn(),
            getAccount: vi.fn(),
            createAccount: vi.fn(),
            updateAccount: vi.fn(),
            deleteAccount: vi.fn(),
        };
        vi.mocked(getAccountRepository).mockReturnValue(mockRepo as any);
    });

    describe('getAccounts', () => {
        it('delegates to repository with correct filters', async () => {
            mockRepo.getAccounts.mockResolvedValue({ accounts: [makeAccount()], totalCount: 1 });

            const result = await AccountService.getAccounts({
                statusFilter: 'active',
                searchTerm: 'test',
                page: 2,
                limit: 5,
                tenantId: 'test-tenant',
            });

            expect(mockRepo.getAccounts).toHaveBeenCalledWith(
                expect.objectContaining({
                    statusFilter: 'active',
                    searchTerm: 'test',
                    page: 2,
                    limit: 5,
                    tenantId: 'test-tenant',
                })
            );
            expect(result.accounts).toHaveLength(1);
            expect(result.totalCount).toBe(1);
        });

        it('passes undefined tenantId when not provided', async () => {
            mockRepo.getAccounts.mockResolvedValue({ accounts: [], totalCount: 0 });

            await AccountService.getAccounts();

            const callArg = mockRepo.getAccounts.mock.calls[0][0];
            expect(callArg.tenantId).toBeUndefined();
        });

        it('uses provided tenantId', async () => {
            mockRepo.getAccounts.mockResolvedValue({ accounts: [], totalCount: 0 });

            await AccountService.getAccounts({ tenantId: 'custom-tenant' });

            const callArg = mockRepo.getAccounts.mock.calls[0][0];
            expect(callArg.tenantId).toBe('custom-tenant');
        });
    });

    describe('getAccount', () => {
        it('returns null when account not found', async () => {
            mockRepo.getAccount.mockResolvedValue(null);

            const result = await AccountService.getAccount('acc-missing', 'test-tenant');

            expect(result).toBeNull();
            expect(mockRepo.getAccount).toHaveBeenCalledWith('acc-missing', 'test-tenant');
        });

        it('returns account when found', async () => {
            mockRepo.getAccount.mockResolvedValue(makeAccount({ name: 'Found Account' }));

            const result = await AccountService.getAccount('acc-1');

            expect(result).not.toBeNull();
            expect(result!.name).toBe('Found Account');
        });

        it('passes custom tenantId to repository', async () => {
            mockRepo.getAccount.mockResolvedValue(null);

            await AccountService.getAccount('acc-1', 'my-tenant');

            expect(mockRepo.getAccount).toHaveBeenCalledWith('acc-1', 'my-tenant');
        });
    });

    describe('createAccount', () => {
        it('calls repo.createAccount and returns the created account', async () => {
            const newAccount = makeAccount({ accountId: 'acc-new', name: 'New Account' });
            mockRepo.createAccount.mockResolvedValue(newAccount);

            const input = {
                accountId: 'acc-new',
                name: 'New Account',
                roleArn: 'arn:aws:iam::111:role/R',
                regions: ['eu-west-1'],
                active: true,
                connectionStatus: 'unknown' as const,
                description: '',
                resourceCount: 0,
                schedulesCount: 0,
                monthlySavings: 0,
                tags: [],
                lastValidated: '',
                createdBy: 'alice',
                updatedBy: 'alice',
            };

            const result = await AccountService.createAccount(input);

            expect(mockRepo.createAccount).toHaveBeenCalledOnce();
            expect(result.accountId).toBe('acc-new');
        });

        it('calls AuditService.logUserAction after creating account', async () => {
            mockRepo.createAccount.mockResolvedValue(makeAccount());

            await AccountService.createAccount(makeAccount());

            expect(AuditService.logUserAction).toHaveBeenCalledWith(
                expect.objectContaining({
                    action: 'Created Account',
                    resourceType: 'account',
                    status: 'success',
                })
            );
        });

        it('uses DEFAULT_TENANT_ID when tenantId not provided', async () => {
            mockRepo.createAccount.mockResolvedValue(makeAccount());

            await AccountService.createAccount(makeAccount(), 'test-tenant');

            expect(mockRepo.createAccount).toHaveBeenCalledWith(
                expect.anything(),
                'test-tenant'
            );
        });
    });

    describe('updateAccount', () => {
        it('calls repo.updateAccount with correct args', async () => {
            mockRepo.updateAccount.mockResolvedValue(makeAccount({ name: 'Updated' }));

            await AccountService.updateAccount('acc-1', { name: 'Updated' }, 'test-tenant');

            expect(mockRepo.updateAccount).toHaveBeenCalledWith(
                'acc-1',
                expect.objectContaining({ name: 'Updated' }),
                'test-tenant'
            );
        });

        it('calls AuditService.logUserAction after updating', async () => {
            mockRepo.updateAccount.mockResolvedValue(makeAccount({ name: 'Updated' }));

            await AccountService.updateAccount('acc-1', { name: 'Updated', updatedBy: 'bob' });

            expect(AuditService.logUserAction).toHaveBeenCalledWith(
                expect.objectContaining({
                    action: 'Updated Account',
                    resourceType: 'account',
                    status: 'success',
                })
            );
        });

        it('returns the updated account from repository', async () => {
            mockRepo.updateAccount.mockResolvedValue(makeAccount({ name: 'New Name' }));

            const result = await AccountService.updateAccount('acc-1', { name: 'New Name' });

            expect(result.name).toBe('New Name');
        });
    });

    describe('deleteAccount', () => {
        it('calls repo.deleteAccount with accountId and tenantId', async () => {
            mockRepo.deleteAccount.mockResolvedValue(undefined);

            await AccountService.deleteAccount('acc-del', 'alice', 'test-tenant');

            expect(mockRepo.deleteAccount).toHaveBeenCalledWith('acc-del', 'test-tenant');
        });

        it('calls AuditService.logUserAction after deleting', async () => {
            mockRepo.deleteAccount.mockResolvedValue(undefined);

            await AccountService.deleteAccount('acc-del', 'alice');

            expect(AuditService.logUserAction).toHaveBeenCalledWith(
                expect.objectContaining({
                    action: 'Deleted Account',
                    resourceType: 'account',
                    user: 'alice',
                    status: 'success',
                })
            );
        });

        it('uses custom tenantId when provided', async () => {
            mockRepo.deleteAccount.mockResolvedValue(undefined);

            await AccountService.deleteAccount('acc-del', 'system', 'custom-tenant');

            expect(mockRepo.deleteAccount).toHaveBeenCalledWith('acc-del', 'custom-tenant');
        });
    });

    describe('validateAccount', () => {
        it('throws when account not found', async () => {
            mockRepo.getAccount.mockResolvedValue(null);

            await expect(AccountService.validateAccount('acc-missing', 'test-tenant')).rejects.toThrow(
                'Failed to validate account'
            );
        });

        it('throws when account has no roleArn', async () => {
            mockRepo.getAccount.mockResolvedValue(makeAccount({ roleArn: '' }));

            await expect(AccountService.validateAccount('acc-1', 'test-tenant')).rejects.toThrow(
                'Failed to validate account'
            );
        });
    });

    describe('toggleAccountStatus', () => {
        it('throws when account not found', async () => {
            mockRepo.getAccount.mockResolvedValue(null);

            await expect(AccountService.toggleAccountStatus('acc-missing', 'test-tenant')).rejects.toThrow(
                'Account acc-missing not found'
            );
        });

        it('toggles active=true to active=false', async () => {
            mockRepo.getAccount.mockResolvedValue(makeAccount({ active: true }));
            mockRepo.updateAccount.mockResolvedValue(makeAccount({ active: false }));

            await AccountService.toggleAccountStatus('acc-1', 'test-tenant');

            expect(mockRepo.updateAccount).toHaveBeenCalledWith(
                'acc-1',
                expect.objectContaining({ active: false }),
                'test-tenant'
            );
        });

        it('toggles active=false to active=true', async () => {
            mockRepo.getAccount.mockResolvedValue(makeAccount({ active: false }));
            mockRepo.updateAccount.mockResolvedValue(makeAccount({ active: true }));

            await AccountService.toggleAccountStatus('acc-1', 'test-tenant');

            expect(mockRepo.updateAccount).toHaveBeenCalledWith(
                'acc-1',
                expect.objectContaining({ active: true }),
                'test-tenant'
            );
        });
    });
});
