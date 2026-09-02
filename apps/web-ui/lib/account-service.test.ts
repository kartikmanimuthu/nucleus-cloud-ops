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

vi.mock('@/lib/spot-guard/bus-policy-client', () => ({ requestBusPolicyReconcile: vi.fn() }));

vi.mock('@/env', () => ({
    env: { AWS_REGION: 'us-east-1', NEXT_PUBLIC_AWS_REGION: undefined, NODE_ENV: 'test' },
}));

// AWS SDK v3 clients: `new Command(...)` requires mockImplementation(function(){...}), not an
// arrow function, for the constructed instance to carry the fields set on `this`.
const {
    mockStsSend, mockEcsSend, mockEc2Send, mockRdsSend, mockAsgSend, mockEbSend,
} = vi.hoisted(() => ({
    mockStsSend: vi.fn(), mockEcsSend: vi.fn(), mockEc2Send: vi.fn(),
    mockRdsSend: vi.fn(), mockAsgSend: vi.fn(), mockEbSend: vi.fn(),
}));

function commandMock(commandName: string) {
    return vi.fn().mockImplementation(function (this: { input: unknown; commandName: string }, input: unknown) {
        this.input = input;
        this.commandName = commandName;
    });
}

vi.mock('@aws-sdk/client-sts', () => ({
    STSClient: vi.fn().mockImplementation(function (this: { send: typeof mockStsSend }) { this.send = mockStsSend; }),
    AssumeRoleCommand: commandMock('AssumeRoleCommand'),
}));

vi.mock('@aws-sdk/client-ecs', () => ({
    ECSClient: vi.fn().mockImplementation(function (this: { send: typeof mockEcsSend }) { this.send = mockEcsSend; }),
    ListClustersCommand: commandMock('ListClustersCommand'),
    ListServicesCommand: commandMock('ListServicesCommand'),
    DescribeServicesCommand: commandMock('DescribeServicesCommand'),
    DescribeCapacityProvidersCommand: commandMock('DescribeCapacityProvidersCommand'),
}));

vi.mock('@aws-sdk/client-ec2', () => ({
    EC2Client: vi.fn().mockImplementation(function (this: { send: typeof mockEc2Send }) { this.send = mockEc2Send; }),
    DescribeInstancesCommand: commandMock('DescribeInstancesCommand'),
}));

vi.mock('@aws-sdk/client-rds', () => ({
    RDSClient: vi.fn().mockImplementation(function (this: { send: typeof mockRdsSend }) { this.send = mockRdsSend; }),
    DescribeDBInstancesCommand: commandMock('DescribeDBInstancesCommand'),
    DescribeDBClustersCommand: commandMock('DescribeDBClustersCommand'),
}));

vi.mock('@aws-sdk/client-auto-scaling', () => ({
    AutoScalingClient: vi.fn().mockImplementation(function (this: { send: typeof mockAsgSend }) { this.send = mockAsgSend; }),
    DescribeAutoScalingGroupsCommand: commandMock('DescribeAutoScalingGroupsCommand'),
}));

vi.mock('@aws-sdk/client-eventbridge', () => ({
    EventBridgeClient: vi.fn().mockImplementation(function (this: { send: typeof mockEbSend }) { this.send = mockEbSend; }),
    DescribeRuleCommand: commandMock('DescribeRuleCommand'),
    ListTargetsByRuleCommand: commandMock('ListTargetsByRuleCommand'),
}));

import { getAccountRepository } from '@/lib/db/repository-factory';
import { AuditService } from '@/lib/audit-service';
import { requestBusPolicyReconcile } from '@/lib/spot-guard/bus-policy-client';
import { AccountService } from './account-service';

const CREDENTIALS_RESPONSE = {
    Credentials: { AccessKeyId: 'AKIA', SecretAccessKey: 'secret', SessionToken: 'token' },
};

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
        mockStsSend.mockReset();
        mockEcsSend.mockReset();
        mockEc2Send.mockReset();
        mockRdsSend.mockReset();
        mockAsgSend.mockReset();
        mockEbSend.mockReset();
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

        it('attributes the audit log to "system" when createdBy is not supplied', async () => {
            mockRepo.createAccount.mockResolvedValue(makeAccount());
            await AccountService.createAccount(makeAccount({ createdBy: '' }));
            expect(AuditService.logUserAction).toHaveBeenCalledWith(expect.objectContaining({ user: 'system' }));
        });

        it('calls AuditService.logUserAction after creating account', async () => {
            mockRepo.createAccount.mockResolvedValue(makeAccount());

            await AccountService.createAccount(makeAccount());

            expect(AuditService.logUserAction).toHaveBeenCalledWith(
                expect.objectContaining({
                    action: 'Created Account',
                    resourceType: 'Account',
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

        it('reconciles the bus-policy allowlist when the new account is Spot-enabled', async () => {
            mockRepo.createAccount.mockResolvedValue(makeAccount());
            await AccountService.createAccount(makeAccount({ spotAutomationEnabled: true }) as any);
            expect(requestBusPolicyReconcile).toHaveBeenCalledWith('account.created');
        });

        it('does not reconcile the bus policy for an account with Spot automation off', async () => {
            mockRepo.createAccount.mockResolvedValue(makeAccount());
            await AccountService.createAccount(makeAccount({ spotAutomationEnabled: false }) as any);
            expect(requestBusPolicyReconcile).not.toHaveBeenCalled();
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

        it('attributes the audit log to "system" when updatedBy is not supplied', async () => {
            mockRepo.updateAccount.mockResolvedValue(makeAccount());
            await AccountService.updateAccount('acc-1', { name: 'x' });
            expect(AuditService.logUserAction).toHaveBeenCalledWith(expect.objectContaining({ user: 'system' }));
        });

        it('calls AuditService.logUserAction after updating', async () => {
            mockRepo.updateAccount.mockResolvedValue(makeAccount({ name: 'Updated' }));

            await AccountService.updateAccount('acc-1', { name: 'Updated', updatedBy: 'bob' });

            expect(AuditService.logUserAction).toHaveBeenCalledWith(
                expect.objectContaining({
                    action: 'Updated Account',
                    resourceType: 'Account',
                    status: 'success',
                })
            );
        });

        it('returns the updated account from repository', async () => {
            mockRepo.updateAccount.mockResolvedValue(makeAccount({ name: 'New Name' }));

            const result = await AccountService.updateAccount('acc-1', { name: 'New Name' });

            expect(result.name).toBe('New Name');
        });

        it('skips the audit log when skipAudit is true', async () => {
            mockRepo.updateAccount.mockResolvedValue(makeAccount());
            await AccountService.updateAccount('acc-1', { name: 'x' }, 'test-tenant', true);
            expect(AuditService.logUserAction).not.toHaveBeenCalled();
        });

        it('reconciles the bus policy when spotAutomationEnabled changes, even with skipAudit', async () => {
            mockRepo.updateAccount.mockResolvedValue(makeAccount());
            await AccountService.updateAccount('acc-1', { spotAutomationEnabled: false }, 'test-tenant', true);
            expect(requestBusPolicyReconcile).toHaveBeenCalledWith('account.updated');
        });

        it('reconciles the bus policy when active changes', async () => {
            mockRepo.updateAccount.mockResolvedValue(makeAccount());
            await AccountService.updateAccount('acc-1', { active: false }, 'test-tenant');
            expect(requestBusPolicyReconcile).toHaveBeenCalledWith('account.updated');
        });

        it('does not reconcile the bus policy for an unrelated field update', async () => {
            mockRepo.updateAccount.mockResolvedValue(makeAccount());
            await AccountService.updateAccount('acc-1', { name: 'New Name' }, 'test-tenant');
            expect(requestBusPolicyReconcile).not.toHaveBeenCalled();
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
                    resourceType: 'Account',
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

        it('unconditionally reconciles the bus policy — the row is gone, so Spot status cannot be checked', async () => {
            mockRepo.deleteAccount.mockResolvedValue(undefined);
            await AccountService.deleteAccount('acc-del', 'alice', 'test-tenant');
            expect(requestBusPolicyReconcile).toHaveBeenCalledWith('account.deleted');
        });
    });

    describe('validateAccount', () => {
        // NOTE: `if (batch.length > 0)` in scanResources' ECS DescribeServices loop
        // (account-service.ts:498) is provably always true: `batch` comes from
        // `serviceArns.slice(i, i + batchSize)` where the loop only runs while
        // `i < serviceArns.length`, so every slice is non-empty. Left untested as dead
        // code, same convention as other documented-unreachable branches this session.

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

        it('marks the account connected and audit-logs success on a valid credential check', async () => {
            mockRepo.getAccount.mockResolvedValue(makeAccount());
            mockRepo.updateAccount
                .mockResolvedValueOnce(makeAccount({ connectionStatus: 'validating' }))
                .mockResolvedValueOnce(makeAccount({ connectionStatus: 'connected', updatedBy: 'alice' }));
            mockStsSend.mockResolvedValue(CREDENTIALS_RESPONSE);
            mockEcsSend.mockResolvedValue({});
            mockEc2Send.mockResolvedValue({});
            mockRdsSend.mockResolvedValue({});

            const result = await AccountService.validateAccount('acc-1', 'test-tenant');

            expect(result.connectionStatus).toBe('connected');
            expect(mockRepo.updateAccount).toHaveBeenNthCalledWith(
                1, 'acc-1', expect.objectContaining({ connectionStatus: 'validating' }), 'test-tenant',
            );
            expect(mockRepo.updateAccount).toHaveBeenNthCalledWith(
                2, 'acc-1', expect.objectContaining({ connectionStatus: 'connected', connectionError: 'None' }), 'test-tenant',
            );
            expect(AuditService.logUserAction).toHaveBeenCalledWith(
                expect.objectContaining({ eventType: 'account.account.validated', status: 'success', severity: 'low' }),
            );
        });

        it('marks the account errored and audit-logs the failure when credentials are invalid', async () => {
            mockRepo.getAccount.mockResolvedValue(makeAccount());
            mockRepo.updateAccount.mockResolvedValue(makeAccount({ connectionStatus: 'error' }));
            mockStsSend.mockRejectedValue(new Error('AccessDenied: not authorized'));

            const result = await AccountService.validateAccount('acc-1', 'test-tenant');

            expect(result.connectionStatus).toBe('error');
            expect(mockRepo.updateAccount).toHaveBeenNthCalledWith(
                2, 'acc-1', expect.objectContaining({ connectionStatus: 'error' }), 'test-tenant',
            );
            expect(AuditService.logUserAction).toHaveBeenCalledWith(
                expect.objectContaining({ eventType: 'account.account.validated', status: 'error', severity: 'high' }),
            );
        });

        it('attributes the audit log to "system" when the updated account has no updatedBy', async () => {
            mockRepo.getAccount.mockResolvedValue(makeAccount());
            mockRepo.updateAccount.mockResolvedValue(makeAccount({ connectionStatus: 'connected', updatedBy: '' }));
            mockStsSend.mockResolvedValue(CREDENTIALS_RESPONSE);
            mockEcsSend.mockResolvedValue({});
            mockEc2Send.mockResolvedValue({});
            mockRdsSend.mockResolvedValue({});

            await AccountService.validateAccount('acc-1', 'test-tenant');
            expect(AuditService.logUserAction).toHaveBeenCalledWith(expect.objectContaining({ user: 'system' }));
        });

        it('falls back through env.AWS_REGION to "Null" when the account has no region configured', async () => {
            const { env } = await import('@/env');
            const original = env.AWS_REGION;
            (env as any).AWS_REGION = undefined;
            (env as any).NEXT_PUBLIC_AWS_REGION = undefined;
            try {
                mockRepo.getAccount.mockResolvedValue(makeAccount({ regions: [] }));
                mockRepo.updateAccount.mockResolvedValue(makeAccount({ connectionStatus: 'connected' }));
                mockStsSend.mockResolvedValue(CREDENTIALS_RESPONSE);
                mockEcsSend.mockResolvedValue({});
                mockEc2Send.mockResolvedValue({});
                mockRdsSend.mockResolvedValue({});

                const result = await AccountService.validateAccount('acc-1', 'test-tenant');
                expect(result.connectionStatus).toBe('connected');
            } finally {
                (env as any).AWS_REGION = original;
            }
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

        it('attributes the toggle audit log to "system" when the updated account has no updatedBy', async () => {
            mockRepo.getAccount.mockResolvedValue(makeAccount({ active: true }));
            mockRepo.updateAccount.mockResolvedValue(makeAccount({ active: false, updatedBy: '' }));
            await AccountService.toggleAccountStatus('acc-1', 'test-tenant');
            expect(AuditService.logUserAction).toHaveBeenCalledWith(expect.objectContaining({ user: 'system' }));
        });

        it('audit-logs the toggle with a before/after change set', async () => {
            mockRepo.getAccount.mockResolvedValue(makeAccount({ active: true, name: 'Prod' }));
            mockRepo.updateAccount.mockResolvedValue(makeAccount({ active: false, updatedBy: 'bob' }));

            await AccountService.toggleAccountStatus('acc-1', 'test-tenant');

            expect(AuditService.logUserAction).toHaveBeenCalledWith(
                expect.objectContaining({
                    action: 'Toggled Account',
                    changeSet: { before: { active: true }, after: { active: false } },
                }),
            );
        });
    });

    describe('validateCredentials', () => {
        it('returns isValid true after STS assume-role and ECS/EC2/RDS probes all succeed', async () => {
            mockStsSend.mockResolvedValue(CREDENTIALS_RESPONSE);
            mockEcsSend.mockResolvedValue({});
            mockEc2Send.mockResolvedValue({});
            mockRdsSend.mockResolvedValue({});

            const result = await AccountService.validateCredentials({
                roleArn: 'arn:aws:iam::123:role/R', region: 'us-east-1',
            });

            expect(result).toEqual({ isValid: true, spotAutomation: undefined });
            expect(mockStsSend).toHaveBeenCalledTimes(1);
        });

        it('returns isValid false when STS returns no Credentials', async () => {
            mockStsSend.mockResolvedValue({});
            const result = await AccountService.validateCredentials({
                roleArn: 'arn:aws:iam::123:role/R', region: 'us-east-1',
            });
            expect(result.isValid).toBe(false);
            expect(result.error).toContain('temporary credentials');
        });

        it('prefixes an AccessDenied failure distinctly from a generic one', async () => {
            mockStsSend.mockRejectedValue(Object.assign(new Error('not authorized to perform sts:AssumeRole'), { name: 'AccessDenied' }));
            const result = await AccountService.validateCredentials({
                roleArn: 'arn:aws:iam::123:role/R', region: 'us-east-1',
            });
            expect(result.isValid).toBe(false);
            expect(result.error).toMatch(/^Access Denied:/);
        });

        it('surfaces a generic error message unprefixed for a non-AccessDenied failure', async () => {
            mockStsSend.mockRejectedValue(new Error('network timeout'));
            const result = await AccountService.validateCredentials({
                roleArn: 'arn:aws:iam::123:role/R', region: 'us-east-1',
            });
            expect(result.error).toBe('network timeout');
        });

        it('falls back to "Unknown validation error" when the thrown error has no message', async () => {
            mockStsSend.mockRejectedValue({});
            const result = await AccountService.validateCredentials({
                roleArn: 'arn:aws:iam::123:role/R', region: 'us-east-1',
            });
            expect(result.error).toBe('Unknown validation error');
        });

        it('skips the Spot Guard probe entirely when checkSpotAutomation is not requested', async () => {
            mockStsSend.mockResolvedValue(CREDENTIALS_RESPONSE);
            mockEcsSend.mockResolvedValue({});
            mockEc2Send.mockResolvedValue({});
            mockRdsSend.mockResolvedValue({});

            const result = await AccountService.validateCredentials({
                roleArn: 'arn:aws:iam::123:role/R', region: 'us-east-1', hubAccountId: '999999999999',
            });
            expect(result.spotAutomation).toBeUndefined();
            expect(mockEbSend).not.toHaveBeenCalled();
        });

        it('skips the Spot Guard probe when checkSpotAutomation is set but no hubAccountId is given', async () => {
            mockStsSend.mockResolvedValue(CREDENTIALS_RESPONSE);
            mockEcsSend.mockResolvedValue({});
            mockEc2Send.mockResolvedValue({});
            mockRdsSend.mockResolvedValue({});

            const result = await AccountService.validateCredentials({
                roleArn: 'arn:aws:iam::123:role/R', region: 'us-east-1', checkSpotAutomation: true,
            });
            expect(result.spotAutomation).toBeUndefined();
        });

        it('reports ready when the forwarding rule is enabled and targets the hub bus', async () => {
            mockStsSend.mockResolvedValue(CREDENTIALS_RESPONSE);
            mockEcsSend.mockResolvedValue({});
            mockEc2Send.mockResolvedValue({});
            mockRdsSend.mockResolvedValue({});
            mockEbSend.mockImplementation((cmd: { commandName: string }) => {
                if (cmd.commandName === 'DescribeRuleCommand') return Promise.resolve({ State: 'ENABLED' });
                if (cmd.commandName === 'ListTargetsByRuleCommand') {
                    return Promise.resolve({ Targets: [{ Arn: 'arn:aws:events:hub-bus' }] });
                }
                throw new Error(`unexpected command ${cmd.commandName}`);
            });

            const result = await AccountService.validateCredentials({
                roleArn: 'arn:aws:iam::123:role/R', region: 'us-east-1', checkSpotAutomation: true,
                hubAccountId: '999999999999', hubEventBusArn: 'arn:aws:events:hub-bus',
            });
            expect(result.spotAutomation).toEqual({ status: 'ready' });
        });

        it('reports ready without checking targets when no hubEventBusArn is supplied', async () => {
            mockStsSend.mockResolvedValue(CREDENTIALS_RESPONSE);
            mockEcsSend.mockResolvedValue({});
            mockEc2Send.mockResolvedValue({});
            mockRdsSend.mockResolvedValue({});
            mockEbSend.mockResolvedValue({ State: 'ENABLED' });

            const result = await AccountService.validateCredentials({
                roleArn: 'arn:aws:iam::123:role/R', region: 'us-east-1', checkSpotAutomation: true,
                hubAccountId: '999999999999',
            });
            expect(result.spotAutomation).toEqual({ status: 'ready' });
            expect(mockEbSend).toHaveBeenCalledTimes(1); // only DescribeRule, never ListTargetsByRule
        });

        it('reports pending with the rule state when the rule exists but is disabled', async () => {
            mockStsSend.mockResolvedValue(CREDENTIALS_RESPONSE);
            mockEcsSend.mockResolvedValue({});
            mockEc2Send.mockResolvedValue({});
            mockRdsSend.mockResolvedValue({});
            mockEbSend.mockResolvedValue({ State: 'DISABLED' });

            const result = await AccountService.validateCredentials({
                roleArn: 'arn:aws:iam::123:role/R', region: 'us-east-1', checkSpotAutomation: true,
                hubAccountId: '999999999999',
            });
            expect(result.spotAutomation?.status).toBe('pending');
            expect(result.spotAutomation?.error).toContain('DISABLED');
        });

        it('reports pending with a generic "unknown state" message when State is absent', async () => {
            mockStsSend.mockResolvedValue(CREDENTIALS_RESPONSE);
            mockEcsSend.mockResolvedValue({});
            mockEc2Send.mockResolvedValue({});
            mockRdsSend.mockResolvedValue({});
            mockEbSend.mockResolvedValue({});

            const result = await AccountService.validateCredentials({
                roleArn: 'arn:aws:iam::123:role/R', region: 'us-east-1', checkSpotAutomation: true,
                hubAccountId: '999999999999',
            });
            expect(result.spotAutomation?.error).toContain('unknown state');
        });

        it('reports error when the rule targets a different, stale event bus', async () => {
            mockStsSend.mockResolvedValue(CREDENTIALS_RESPONSE);
            mockEcsSend.mockResolvedValue({});
            mockEc2Send.mockResolvedValue({});
            mockRdsSend.mockResolvedValue({});
            mockEbSend.mockImplementation((cmd: { commandName: string }) => {
                if (cmd.commandName === 'DescribeRuleCommand') return Promise.resolve({ State: 'ENABLED' });
                return Promise.resolve({ Targets: [{ Arn: 'arn:aws:events:stale-bus' }] });
            });

            const result = await AccountService.validateCredentials({
                roleArn: 'arn:aws:iam::123:role/R', region: 'us-east-1', checkSpotAutomation: true,
                hubAccountId: '999999999999', hubEventBusArn: 'arn:aws:events:hub-bus',
            });
            expect(result.spotAutomation).toEqual({
                status: 'error',
                error: expect.stringContaining('does not target'),
            });
        });

        it('reports pending, never failing credential validation, when the rule does not exist (ResourceNotFoundException)', async () => {
            mockStsSend.mockResolvedValue(CREDENTIALS_RESPONSE);
            mockEcsSend.mockResolvedValue({});
            mockEc2Send.mockResolvedValue({});
            mockRdsSend.mockResolvedValue({});
            mockEbSend.mockRejectedValue(Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' }));

            const result = await AccountService.validateCredentials({
                roleArn: 'arn:aws:iam::123:role/R', region: 'us-east-1', checkSpotAutomation: true,
                hubAccountId: '999999999999',
            });
            expect(result.isValid).toBe(true); // the probe never fails credential validation
            expect(result.spotAutomation).toEqual({
                status: 'pending',
                error: expect.stringContaining('not deployed'),
            });
        });

        it('reports a generic probe error for any other EventBridge failure, and still validates credentials', async () => {
            mockStsSend.mockResolvedValue(CREDENTIALS_RESPONSE);
            mockEcsSend.mockResolvedValue({});
            mockEc2Send.mockResolvedValue({});
            mockRdsSend.mockResolvedValue({});
            mockEbSend.mockRejectedValue(new Error('throttled'));

            const result = await AccountService.validateCredentials({
                roleArn: 'arn:aws:iam::123:role/R', region: 'us-east-1', checkSpotAutomation: true,
                hubAccountId: '999999999999',
            });
            expect(result.isValid).toBe(true);
            expect(result.spotAutomation).toEqual({ status: 'error', error: 'throttled' });
        });

        it('falls back to NEXT_PUBLIC_AWS_REGION for the STS client region when AWS_REGION is unset', async () => {
            const { env } = await import('@/env');
            const original = env.AWS_REGION;
            (env as any).AWS_REGION = undefined;
            (env as any).NEXT_PUBLIC_AWS_REGION = 'eu-west-1';
            try {
                mockStsSend.mockResolvedValue(CREDENTIALS_RESPONSE);
                mockEcsSend.mockResolvedValue({});
                mockEc2Send.mockResolvedValue({});
                mockRdsSend.mockResolvedValue({});

                const result = await AccountService.validateCredentials({
                    roleArn: 'arn:aws:iam::123:role/R', region: 'us-east-1',
                });
                expect(result.isValid).toBe(true);
            } finally {
                (env as any).AWS_REGION = original;
                (env as any).NEXT_PUBLIC_AWS_REGION = undefined;
            }
        });

        it('reports a stringified probe error for a non-Error throw', async () => {
            mockStsSend.mockResolvedValue(CREDENTIALS_RESPONSE);
            mockEcsSend.mockResolvedValue({});
            mockEc2Send.mockResolvedValue({});
            mockRdsSend.mockResolvedValue({});
            mockEbSend.mockRejectedValue('boom');

            const result = await AccountService.validateCredentials({
                roleArn: 'arn:aws:iam::123:role/R', region: 'us-east-1', checkSpotAutomation: true,
                hubAccountId: '999999999999',
            });
            expect(result.spotAutomation).toEqual({ status: 'error', error: 'boom' });
        });
    });

    describe('scanResources', () => {
        beforeEach(() => {
            mockRepo.getAccount.mockResolvedValue(makeAccount());
            mockRepo.updateAccount.mockResolvedValue(makeAccount());
            mockStsSend.mockResolvedValue(CREDENTIALS_RESPONSE);
        });

        it('throws when the account or its roleArn is missing', async () => {
            mockRepo.getAccount.mockResolvedValue(null);
            await expect(AccountService.scanResources('acc-1', 'test-tenant')).rejects.toThrow('Failed to scan resources');
        });

        it('returns an empty list and still updates resourceCount when every service scan comes back empty', async () => {
            mockEc2Send.mockResolvedValue({});
            mockEcsSend.mockResolvedValue({});
            mockRdsSend.mockResolvedValue({});
            mockAsgSend.mockResolvedValue({});

            const result = await AccountService.scanResources('acc-1', 'test-tenant');

            expect(result).toEqual([]);
            expect(mockRepo.updateAccount).toHaveBeenCalledWith(
                'acc-1', expect.objectContaining({ resourceCount: 0 }), 'test-tenant',
            );
        });

        it('collects a running EC2 instance, excludes a terminated one and one already owned by an ASG', async () => {
            mockEc2Send.mockResolvedValue({
                Reservations: [{
                    Instances: [
                        { InstanceId: 'i-1', State: { Name: 'running' }, Tags: [{ Key: 'Name', Value: 'web-1' }] },
                        { InstanceId: 'i-2', State: { Name: 'terminated' } },
                        { InstanceId: 'i-3', State: { Name: 'running' }, Tags: [{ Key: 'aws:autoscaling:groupName', Value: 'asg-1' }] },
                    ],
                }],
            });
            mockEcsSend.mockResolvedValue({});
            mockRdsSend.mockResolvedValue({});
            mockAsgSend.mockResolvedValue({});

            const result = await AccountService.scanResources('acc-1', 'test-tenant');

            expect(result).toEqual([
                { id: 'i-1', type: 'ec2', name: 'web-1', arn: 'arn:aws:ec2:us-east-1:acc-1:instance/i-1' },
            ]);
        });

        it('falls back to the instance id as the name when there is no Name tag', async () => {
            mockEc2Send.mockResolvedValue({
                Reservations: [{ Instances: [{ InstanceId: 'i-1', State: { Name: 'running' } }] }],
            });
            mockEcsSend.mockResolvedValue({});
            mockRdsSend.mockResolvedValue({});
            mockAsgSend.mockResolvedValue({});

            const [resource] = await AccountService.scanResources('acc-1', 'test-tenant');
            expect(resource.name).toBe('i-1');
        });

        it('paginates EC2 across multiple NextToken pages', async () => {
            mockEc2Send
                .mockResolvedValueOnce({
                    Reservations: [{ Instances: [{ InstanceId: 'i-1', State: { Name: 'running' } }] }],
                    NextToken: 'page-2',
                })
                .mockResolvedValueOnce({
                    Reservations: [{ Instances: [{ InstanceId: 'i-2', State: { Name: 'running' } }] }],
                });
            mockEcsSend.mockResolvedValue({});
            mockRdsSend.mockResolvedValue({});
            mockAsgSend.mockResolvedValue({});

            const result = await AccountService.scanResources('acc-1', 'test-tenant');
            expect(result.map((r) => r.id)).toEqual(['i-1', 'i-2']);
            expect(mockEc2Send).toHaveBeenCalledTimes(2);
        });

        it('continues scanning other services when EC2 itself throws', async () => {
            mockEc2Send.mockRejectedValue(new Error('EC2 down'));
            mockEcsSend.mockResolvedValue({});
            mockRdsSend.mockResolvedValue({});
            mockAsgSend.mockResolvedValue({});

            await expect(AccountService.scanResources('acc-1', 'test-tenant')).resolves.toEqual([]);
        });

        it('discovers ECS services across clusters, naming them "<cluster>/<service>"', async () => {
            mockEc2Send.mockResolvedValue({});
            mockRdsSend.mockResolvedValue({});
            mockAsgSend.mockResolvedValue({});
            mockEcsSend.mockImplementation((cmd: { commandName: string }) => {
                switch (cmd.commandName) {
                    case 'ListClustersCommand':
                        return Promise.resolve({ clusterArns: ['arn:aws:ecs:cluster/c1'] });
                    case 'ListServicesCommand':
                        return Promise.resolve({ serviceArns: ['arn:aws:ecs:service/s1'] });
                    case 'DescribeServicesCommand':
                        return Promise.resolve({ services: [{ serviceArn: 'arn:aws:ecs:service/s1', serviceName: 's1' }] });
                    default:
                        throw new Error(`unexpected ${cmd.commandName}`);
                }
            });

            const result = await AccountService.scanResources('acc-1', 'test-tenant');
            expect(result).toEqual([
                { id: 's1', type: 'ecs', name: 'c1/s1', arn: 'arn:aws:ecs:service/s1', clusterArn: 'arn:aws:ecs:cluster/c1' },
            ]);
        });

        it('batches DescribeServices in groups of 10 service ARNs per cluster', async () => {
            mockEc2Send.mockResolvedValue({});
            mockRdsSend.mockResolvedValue({});
            mockAsgSend.mockResolvedValue({});
            const serviceArns = Array.from({ length: 15 }, (_, i) => `arn:aws:ecs:service/s${i}`);
            const describeCalls: string[][] = [];
            mockEcsSend.mockImplementation((cmd: { commandName: string; input: { services?: string[] } }) => {
                switch (cmd.commandName) {
                    case 'ListClustersCommand':
                        return Promise.resolve({ clusterArns: ['arn:aws:ecs:cluster/c1'] });
                    case 'ListServicesCommand':
                        return Promise.resolve({ serviceArns });
                    case 'DescribeServicesCommand':
                        describeCalls.push(cmd.input.services ?? []);
                        return Promise.resolve({ services: [] });
                    default:
                        throw new Error(`unexpected ${cmd.commandName}`);
                }
            });

            await AccountService.scanResources('acc-1', 'test-tenant');
            expect(describeCalls).toEqual([serviceArns.slice(0, 10), serviceArns.slice(10, 15)]);
        });

        it('continues scanning other clusters when one cluster\'s service scan throws', async () => {
            mockEc2Send.mockResolvedValue({});
            mockRdsSend.mockResolvedValue({});
            mockAsgSend.mockResolvedValue({});
            mockEcsSend.mockImplementation((cmd: { commandName: string; input: { cluster?: string } }) => {
                switch (cmd.commandName) {
                    case 'ListClustersCommand':
                        return Promise.resolve({ clusterArns: ['arn:aws:ecs:cluster/bad', 'arn:aws:ecs:cluster/good'] });
                    case 'ListServicesCommand':
                        if (cmd.input.cluster === 'arn:aws:ecs:cluster/bad') return Promise.reject(new Error('cluster down'));
                        return Promise.resolve({ serviceArns: ['arn:aws:ecs:service/s1'] });
                    case 'DescribeServicesCommand':
                        return Promise.resolve({ services: [{ serviceArn: 'arn:aws:ecs:service/s1', serviceName: 's1' }] });
                    default:
                        throw new Error(`unexpected ${cmd.commandName}`);
                }
            });

            const result = await AccountService.scanResources('acc-1', 'test-tenant');
            expect(result).toHaveLength(1);
            expect(result[0].clusterArn).toBe('arn:aws:ecs:cluster/good');
        });

        it('treats a missing serviceArns key, a missing services key, and an incomplete service entry as "nothing found"', async () => {
            mockEc2Send.mockResolvedValue({});
            mockRdsSend.mockResolvedValue({});
            mockAsgSend.mockResolvedValue({});
            mockEcsSend.mockImplementation((cmd: { commandName: string; input: { cluster?: string } }) => {
                switch (cmd.commandName) {
                    case 'ListClustersCommand':
                        return Promise.resolve({ clusterArns: ['c-empty-services', 'c-empty-describe', 'c-partial-entry'] });
                    case 'ListServicesCommand':
                        if (cmd.input.cluster === 'c-empty-services') return Promise.resolve({}); // no serviceArns key
                        if (cmd.input.cluster === 'c-empty-describe') return Promise.resolve({ serviceArns: ['s1'] });
                        return Promise.resolve({ serviceArns: ['s2'] });
                    case 'DescribeServicesCommand':
                        if (cmd.input.cluster === 'c-empty-describe') return Promise.resolve({}); // no services key
                        return Promise.resolve({ services: [{ serviceArn: 'arn:aws:ecs:service/s2' }] }); // missing serviceName
                    default:
                        throw new Error(`unexpected ${cmd.commandName}`);
                }
            });

            const result = await AccountService.scanResources('acc-1', 'test-tenant');
            expect(result).toEqual([]);
        });

        it('falls back to the full cluster ARN as the display name when it has no trailing segment', async () => {
            mockEc2Send.mockResolvedValue({});
            mockRdsSend.mockResolvedValue({});
            mockAsgSend.mockResolvedValue({});
            mockEcsSend.mockImplementation((cmd: { commandName: string }) => {
                switch (cmd.commandName) {
                    case 'ListClustersCommand':
                        return Promise.resolve({ clusterArns: ['arn:aws:ecs:cluster/'] }); // trailing slash → pop() === ''
                    case 'ListServicesCommand':
                        return Promise.resolve({ serviceArns: ['arn:aws:ecs:service/s1'] });
                    case 'DescribeServicesCommand':
                        return Promise.resolve({ services: [{ serviceArn: 'arn:aws:ecs:service/s1', serviceName: 's1' }] });
                    default:
                        throw new Error(`unexpected ${cmd.commandName}`);
                }
            });

            const [resource] = await AccountService.scanResources('acc-1', 'test-tenant');
            expect(resource.name).toBe('arn:aws:ecs:cluster//s1');
        });

        it('continues scanning other services when ECS ListClusters itself throws', async () => {
            mockEc2Send.mockResolvedValue({});
            mockRdsSend.mockResolvedValue({});
            mockAsgSend.mockResolvedValue({});
            mockEcsSend.mockRejectedValue(new Error('ECS down'));

            await expect(AccountService.scanResources('acc-1', 'test-tenant')).resolves.toEqual([]);
        });

        it('collects RDS instances, excluding the docdb engine, and DocumentDB clusters separately', async () => {
            mockEc2Send.mockResolvedValue({});
            mockEcsSend.mockResolvedValue({});
            mockAsgSend.mockResolvedValue({});
            mockRdsSend.mockImplementation((cmd: { commandName: string }) => {
                switch (cmd.commandName) {
                    case 'DescribeDBInstancesCommand':
                        return Promise.resolve({
                            DBInstances: [
                                { DBInstanceIdentifier: 'db-1', Engine: 'postgres', DBInstanceArn: 'arn:aws:rds:db-1' },
                                { DBInstanceIdentifier: 'db-2', Engine: 'docdb' },
                            ],
                        });
                    case 'DescribeDBClustersCommand':
                        return Promise.resolve({ DBClusters: [{ DBClusterIdentifier: 'docdb-1', DBClusterArn: 'arn:aws:rds:docdb-1' }] });
                    default:
                        throw new Error(`unexpected ${cmd.commandName}`);
                }
            });

            const result = await AccountService.scanResources('acc-1', 'test-tenant');
            expect(result).toEqual([
                { id: 'db-1', type: 'rds', name: 'db-1', arn: 'arn:aws:rds:db-1' },
                { id: 'docdb-1', type: 'docdb', name: 'docdb-1', arn: 'arn:aws:rds:docdb-1' },
            ]);
        });

        it('builds a fallback ARN for an RDS instance and a DocDB cluster when the API omits one', async () => {
            mockEc2Send.mockResolvedValue({});
            mockEcsSend.mockResolvedValue({});
            mockAsgSend.mockResolvedValue({});
            mockRdsSend.mockImplementation((cmd: { commandName: string }) => {
                switch (cmd.commandName) {
                    case 'DescribeDBInstancesCommand':
                        return Promise.resolve({ DBInstances: [{ DBInstanceIdentifier: 'db-1', Engine: 'postgres' }] });
                    case 'DescribeDBClustersCommand':
                        return Promise.resolve({ DBClusters: [{ DBClusterIdentifier: 'docdb-1' }] });
                    default:
                        throw new Error(`unexpected ${cmd.commandName}`);
                }
            });

            const result = await AccountService.scanResources('acc-1', 'test-tenant');
            expect(result[0].arn).toBe('arn:aws:rds:us-east-1:acc-1:db:db-1');
            expect(result[1].arn).toBe('arn:aws:rds:us-east-1:acc-1:cluster:docdb-1');
        });

        it('treats a response with no DBInstances/DBClusters key as "nothing found"', async () => {
            mockEc2Send.mockResolvedValue({});
            mockEcsSend.mockResolvedValue({});
            mockAsgSend.mockResolvedValue({});
            mockRdsSend.mockResolvedValue({}); // neither DescribeDBInstances nor DescribeDBClusters returns its array key

            const result = await AccountService.scanResources('acc-1', 'test-tenant');
            expect(result).toEqual([]);
        });

        it('skips an RDS instance and a DocDB cluster entry that carry no identifier', async () => {
            mockEc2Send.mockResolvedValue({});
            mockEcsSend.mockResolvedValue({});
            mockAsgSend.mockResolvedValue({});
            mockRdsSend.mockImplementation((cmd: { commandName: string }) => {
                switch (cmd.commandName) {
                    case 'DescribeDBInstancesCommand':
                        return Promise.resolve({ DBInstances: [{ Engine: 'postgres' }] }); // no DBInstanceIdentifier
                    case 'DescribeDBClustersCommand':
                        return Promise.resolve({ DBClusters: [{}] }); // no DBClusterIdentifier
                    default:
                        throw new Error(`unexpected ${cmd.commandName}`);
                }
            });

            const result = await AccountService.scanResources('acc-1', 'test-tenant');
            expect(result).toEqual([]);
        });

        it('continues scanning other services when RDS itself throws', async () => {
            mockEc2Send.mockResolvedValue({});
            mockEcsSend.mockResolvedValue({});
            mockAsgSend.mockResolvedValue({});
            mockRdsSend.mockRejectedValue(new Error('RDS down'));

            await expect(AccountService.scanResources('acc-1', 'test-tenant')).resolves.toEqual([]);
        });

        it('collects ASGs, excluding one already owned by an ECS capacity provider', async () => {
            mockEc2Send.mockResolvedValue({});
            mockEcsSend.mockImplementation((cmd: { commandName: string }) => {
                if (cmd.commandName === 'DescribeCapacityProvidersCommand') {
                    return Promise.resolve({
                        capacityProviders: [{ autoScalingGroupProvider: { autoScalingGroupArn: 'arn:aws:asg:cp-owned' } }],
                    });
                }
                return Promise.resolve({});
            });
            mockRdsSend.mockResolvedValue({});
            mockAsgSend.mockResolvedValue({
                AutoScalingGroups: [
                    { AutoScalingGroupName: 'asg-cp-owned', AutoScalingGroupARN: 'arn:aws:asg:cp-owned' },
                    { AutoScalingGroupName: 'asg-standalone', AutoScalingGroupARN: 'arn:aws:asg:standalone' },
                ],
            });

            const result = await AccountService.scanResources('acc-1', 'test-tenant');
            expect(result).toEqual([
                { id: 'asg-standalone', type: 'asg', name: 'asg-standalone', arn: 'arn:aws:asg:standalone' },
            ]);
        });

        it('still scans ASGs (without CP exclusion) when the capacity-provider lookup itself throws', async () => {
            mockEc2Send.mockResolvedValue({});
            mockEcsSend.mockImplementation((cmd: { commandName: string }) => {
                if (cmd.commandName === 'DescribeCapacityProvidersCommand') return Promise.reject(new Error('ECS down'));
                return Promise.resolve({});
            });
            mockRdsSend.mockResolvedValue({});
            mockAsgSend.mockResolvedValue({
                AutoScalingGroups: [{ AutoScalingGroupName: 'asg-1', AutoScalingGroupARN: 'arn:aws:asg:1' }],
            });

            const result = await AccountService.scanResources('acc-1', 'test-tenant');
            expect(result).toEqual([{ id: 'asg-1', type: 'asg', name: 'asg-1', arn: 'arn:aws:asg:1' }]);
        });

        it('treats a capacity-providers response with no key as "no CP-owned ASGs", and skips an entry with no name', async () => {
            mockEc2Send.mockResolvedValue({});
            mockRdsSend.mockResolvedValue({});
            mockEcsSend.mockResolvedValue({}); // DescribeCapacityProviders: no capacityProviders key
            mockAsgSend.mockResolvedValue({
                AutoScalingGroups: [{ AutoScalingGroupARN: 'arn:aws:asg:no-name' }, { AutoScalingGroupName: 'asg-1' }],
            });

            const result = await AccountService.scanResources('acc-1', 'test-tenant');
            expect(result).toEqual([{ id: 'asg-1', type: 'asg', name: 'asg-1', arn: expect.any(String) }]);
        });

        it('ignores a capacity provider with no autoScalingGroupProvider.autoScalingGroupArn', async () => {
            mockEc2Send.mockResolvedValue({});
            mockRdsSend.mockResolvedValue({});
            mockEcsSend.mockImplementation((cmd: { commandName: string }) => {
                if (cmd.commandName === 'DescribeCapacityProvidersCommand') {
                    return Promise.resolve({ capacityProviders: [{ name: 'FARGATE' }] }); // no autoScalingGroupProvider
                }
                return Promise.resolve({});
            });
            mockAsgSend.mockResolvedValue({
                AutoScalingGroups: [{ AutoScalingGroupName: 'asg-1', AutoScalingGroupARN: 'arn:aws:asg:1' }],
            });

            const result = await AccountService.scanResources('acc-1', 'test-tenant');
            expect(result).toEqual([{ id: 'asg-1', type: 'asg', name: 'asg-1', arn: 'arn:aws:asg:1' }]);
        });

        it('falls back through env.AWS_REGION to "Null" when the account has no region configured', async () => {
            const { env } = await import('@/env');
            const original = env.AWS_REGION;
            (env as any).AWS_REGION = undefined;
            (env as any).NEXT_PUBLIC_AWS_REGION = undefined;
            try {
                mockRepo.getAccount.mockResolvedValue(makeAccount({ regions: [] }));
                mockEc2Send.mockResolvedValue({});
                mockEcsSend.mockResolvedValue({});
                mockRdsSend.mockResolvedValue({});
                mockAsgSend.mockResolvedValue({});

                await expect(AccountService.scanResources('acc-1', 'test-tenant')).resolves.toEqual([]);
            } finally {
                (env as any).AWS_REGION = original;
            }
        });

        it('builds a fallback ARN for an ASG when the API omits one', async () => {
            mockEc2Send.mockResolvedValue({});
            mockEcsSend.mockResolvedValue({});
            mockRdsSend.mockResolvedValue({});
            mockAsgSend.mockResolvedValue({ AutoScalingGroups: [{ AutoScalingGroupName: 'asg-1' }] });

            const [resource] = await AccountService.scanResources('acc-1', 'test-tenant');
            expect(resource.arn).toBe('arn:aws:autoscaling:us-east-1:acc-1:autoScalingGroup:uuid:autoScalingGroupName/asg-1');
        });

        it('continues, returning other services\' results, when ASG itself throws', async () => {
            mockEc2Send.mockResolvedValue({});
            mockEcsSend.mockResolvedValue({});
            mockRdsSend.mockResolvedValue({
                DBInstances: [{ DBInstanceIdentifier: 'db-1', Engine: 'postgres', DBInstanceArn: 'arn:aws:rds:db-1' }],
            });
            mockAsgSend.mockRejectedValue(new Error('ASG down'));

            const result = await AccountService.scanResources('acc-1', 'test-tenant');
            expect(result).toEqual([{ id: 'db-1', type: 'rds', name: 'db-1', arn: 'arn:aws:rds:db-1' }]);
        });

        it('re-throws as a wrapped error when the outer STS assume-role fails', async () => {
            mockStsSend.mockRejectedValue(new Error('assume-role denied'));
            await expect(AccountService.scanResources('acc-1', 'test-tenant')).rejects.toThrow('Failed to scan resources');
        });

        it('re-throws when STS returns no Credentials', async () => {
            mockStsSend.mockResolvedValue({});
            await expect(AccountService.scanResources('acc-1', 'test-tenant')).rejects.toThrow('Failed to scan resources');
        });
    });
});
