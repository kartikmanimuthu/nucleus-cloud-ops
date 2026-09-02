import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@aws-sdk/client-sts', () => ({
    STSClient: vi.fn().mockImplementation(function (this: any) { this.send = vi.fn(); }),
    AssumeRoleCommand: vi.fn().mockImplementation(function (this: any, input: unknown) { this.input = input; }),
}));
vi.mock('../account-service', () => ({ AccountService: { getAccount: vi.fn(), getAccounts: vi.fn() } }));
vi.mock('./session-manager', () => ({ getOrCreateSessionProfile: vi.fn() }));

import { STSClient } from '@aws-sdk/client-sts';
import { AccountService } from '../account-service';
import { getOrCreateSessionProfile } from './session-manager';
import {
    assumeRoleForAccount, createGetAwsCredentialsTool, createListAwsAccountsTool, generateAwsCredentialPrefix,
} from './aws-credentials-tool';

describe('assumeRoleForAccount', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns credentials and expiration from STS', async () => {
        const expiration = new Date('2026-01-01T01:00:00Z');
        const send = vi.fn().mockResolvedValue({ Credentials: { AccessKeyId: 'AK', SecretAccessKey: 'SK', SessionToken: 'ST', Expiration: expiration } });
        vi.mocked(STSClient).mockImplementation(function (this: any) { this.send = send; } as any);

        const result = await assumeRoleForAccount('arn:aws:iam::123:role/x', 'ext-1');
        expect(result.credentials.AccessKeyId).toBe('AK');
        expect(result.expiration).toBe(expiration);
    });

    it('falls back to a 1-hour default expiration when STS omits it', async () => {
        const send = vi.fn().mockResolvedValue({ Credentials: { AccessKeyId: 'AK' } });
        vi.mocked(STSClient).mockImplementation(function (this: any) { this.send = send; } as any);

        const result = await assumeRoleForAccount('arn:aws:iam::123:role/x');
        expect(result.expiration).toBeInstanceOf(Date);
    });

    it('throws when STS returns no Credentials', async () => {
        const send = vi.fn().mockResolvedValue({});
        vi.mocked(STSClient).mockImplementation(function (this: any) { this.send = send; } as any);

        await expect(assumeRoleForAccount('arn:aws:iam::123:role/x')).rejects.toThrow('Failed to obtain temporary credentials');
    });
});

describe('createGetAwsCredentialsTool', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(STSClient).mockImplementation(function (this: any) {
            this.send = vi.fn().mockResolvedValue({ Credentials: { AccessKeyId: 'AK', SecretAccessKey: 'SK', SessionToken: 'ST', Expiration: new Date() } });
        } as any);
    });

    it('returns an error when accountId is blank', async () => {
        const tool = createGetAwsCredentialsTool('tenant-1');
        const result = JSON.parse(await tool.invoke({ accountId: '  ' }));
        expect(result.success).toBe(false);
        expect(result.error).toContain('No account ID provided');
    });

    it('returns an error when the account does not exist', async () => {
        vi.mocked(AccountService.getAccount).mockResolvedValue(null);
        const tool = createGetAwsCredentialsTool('tenant-1');
        const result = JSON.parse(await tool.invoke({ accountId: 'acc-1' }));
        expect(result.success).toBe(false);
        expect(result.error).toContain('not found in the system');
    });

    it('returns an error when the account has no roleArn configured', async () => {
        vi.mocked(AccountService.getAccount).mockResolvedValue({ accountId: 'acc-1', active: true, roleArn: null } as any);
        const tool = createGetAwsCredentialsTool('tenant-1');
        const result = JSON.parse(await tool.invoke({ accountId: 'acc-1' }));
        expect(result.error).toContain('does not have an IAM Role ARN');
    });

    it('returns an error when the account is inactive', async () => {
        vi.mocked(AccountService.getAccount).mockResolvedValue({ accountId: 'acc-1', active: false, roleArn: 'arn:x' } as any);
        const tool = createGetAwsCredentialsTool('tenant-1');
        const result = JSON.parse(await tool.invoke({ accountId: 'acc-1' }));
        expect(result.error).toContain('is currently inactive');
    });

    it('creates a session profile and returns its usage instructions on success', async () => {
        vi.mocked(AccountService.getAccount).mockResolvedValue({
            accountId: 'acc-1', name: 'Prod', active: true, roleArn: 'arn:x', regions: ['us-east-1'],
        } as any);
        vi.mocked(getOrCreateSessionProfile).mockResolvedValue({
            profileName: 'nucleus-acc-1', expiresAt: new Date('2026-01-01T01:00:00Z'),
        } as any);

        const tool = createGetAwsCredentialsTool('tenant-1');
        const result = JSON.parse(await tool.invoke({ accountId: 'acc-1' }));

        expect(result.success).toBe(true);
        expect(result.profileName).toBe('nucleus-acc-1');
        expect(result.region).toBe('us-east-1');
        expect(result.usage).toContain('--profile nucleus-acc-1');
    });

    it('maps an AccessDenied error to a user-friendly message', async () => {
        vi.mocked(AccountService.getAccount).mockResolvedValue({ accountId: 'acc-1', active: true, roleArn: 'arn:x' } as any);
        vi.mocked(getOrCreateSessionProfile).mockRejectedValue(Object.assign(new Error('x'), { name: 'AccessDenied' }));

        const tool = createGetAwsCredentialsTool('tenant-1');
        const result = JSON.parse(await tool.invoke({ accountId: 'acc-1' }));
        expect(result.error).toContain('Access denied when assuming role');
    });

    it('maps a MalformedPolicyDocument error to a user-friendly message', async () => {
        vi.mocked(AccountService.getAccount).mockResolvedValue({ accountId: 'acc-1', active: true, roleArn: 'arn:x' } as any);
        vi.mocked(getOrCreateSessionProfile).mockRejectedValue(Object.assign(new Error('x'), { name: 'MalformedPolicyDocument' }));

        const tool = createGetAwsCredentialsTool('tenant-1');
        const result = JSON.parse(await tool.invoke({ accountId: 'acc-1' }));
        expect(result.error).toContain('Invalid role configuration');
    });
});

describe('createListAwsAccountsTool', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns a message when there are no connected accounts', async () => {
        vi.mocked(AccountService.getAccounts).mockResolvedValue({ accounts: [] } as any);
        const tool = createListAwsAccountsTool('tenant-1');
        const result = JSON.parse(await tool.invoke({}));
        expect(result.success).toBe(true);
        expect(result.accounts).toEqual([]);
    });

    it('lists connected accounts scoped by tenant', async () => {
        vi.mocked(AccountService.getAccounts).mockResolvedValue({
            accounts: [{ accountId: 'acc-1', name: 'Prod', regions: ['us-east-1'] }],
        } as any);
        const tool = createListAwsAccountsTool('tenant-1');
        const result = JSON.parse(await tool.invoke({}));

        expect(AccountService.getAccounts).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-1' }));
        expect(result.accounts).toEqual([{ accountId: 'acc-1', accountName: 'Prod', regions: ['us-east-1'] }]);
    });

    it('returns an error envelope when the service throws', async () => {
        vi.mocked(AccountService.getAccounts).mockRejectedValue(new Error('DB down'));
        const tool = createListAwsAccountsTool('tenant-1');
        const result = JSON.parse(await tool.invoke({}));
        expect(result.success).toBe(false);
        expect(result.error).toBe('DB down');
    });
});

describe('generateAwsCredentialPrefix', () => {
    it('formats the env-var prefix string', () => {
        const prefix = generateAwsCredentialPrefix({
            accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'ST', region: 'us-east-1',
            accountId: 'acc-1', accountName: 'Prod', expiresAt: '2026-01-01T00:00:00Z',
        });
        expect(prefix).toBe('AWS_ACCESS_KEY_ID="AK" AWS_SECRET_ACCESS_KEY="SK" AWS_SESSION_TOKEN="ST" AWS_REGION="us-east-1"');
    });
});
