import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockStsSend, mockAcmSend } = vi.hoisted(() => ({
    mockStsSend: vi.fn(),
    mockAcmSend: vi.fn(),
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

vi.mock('@aws-sdk/client-acm', () => ({
    ACMClient: vi.fn().mockImplementation(function (this: { send: typeof mockAcmSend }) { this.send = mockAcmSend; }),
    ListCertificatesCommand: commandMock('ListCertificatesCommand'),
    DescribeCertificateCommand: commandMock('DescribeCertificateCommand'),
    ImportCertificateCommand: commandMock('ImportCertificateCommand'),
}));

vi.mock('@/env', () => ({ env: { AWS_REGION: 'ap-south-1' } }));

import {
    assumeAccountRole, acmClient, scanAccountCertificates, describeAcmCertificate,
    scannedCertMatchesDomain, importToAcm, runBounded, DEFAULT_REGION,
} from './certificate-aws';

const CREDS = { accessKeyId: 'AKIA', secretAccessKey: 'secret', sessionToken: 'token' };
const ACCOUNT = { accountId: '123456789012', roleArn: 'arn:aws:iam::123456789012:role/Nucleus' };

beforeEach(() => {
    vi.clearAllMocks();
});

describe('DEFAULT_REGION', () => {
    it('reads from env.AWS_REGION', () => {
        expect(DEFAULT_REGION).toBe('ap-south-1');
    });

    it('falls back to ap-south-1 when AWS_REGION is unset', async () => {
        vi.resetModules();
        vi.doMock('@aws-sdk/client-sts', () => ({
            STSClient: vi.fn().mockImplementation(function (this: { send: typeof mockStsSend }) { this.send = mockStsSend; }),
            AssumeRoleCommand: commandMock('AssumeRoleCommand'),
        }));
        vi.doMock('@aws-sdk/client-acm', () => ({
            ACMClient: vi.fn().mockImplementation(function (this: { send: typeof mockAcmSend }) { this.send = mockAcmSend; }),
            ListCertificatesCommand: commandMock('ListCertificatesCommand'),
            DescribeCertificateCommand: commandMock('DescribeCertificateCommand'),
            ImportCertificateCommand: commandMock('ImportCertificateCommand'),
        }));
        vi.doMock('@/env', () => ({ env: { AWS_REGION: undefined } }));
        const fresh = await import('./certificate-aws');
        expect(fresh.DEFAULT_REGION).toBe('ap-south-1');
    });
});

describe('assumeAccountRole', () => {
    it('returns credentials on a successful assume-role', async () => {
        mockStsSend.mockResolvedValue({
            Credentials: { AccessKeyId: 'AKIA', SecretAccessKey: 'secret', SessionToken: 'token' },
        });
        const result = await assumeAccountRole(ACCOUNT, 'us-east-1', 'session-1');
        expect(result).toEqual(CREDS);
    });

    it('omits ExternalId when the account has none', async () => {
        mockStsSend.mockResolvedValue({ Credentials: { AccessKeyId: 'a', SecretAccessKey: 'b', SessionToken: 'c' } });
        await assumeAccountRole(ACCOUNT, 'us-east-1', 'session-1');
        expect(mockStsSend.mock.calls[0][0].input).not.toHaveProperty('ExternalId');
    });

    it('includes ExternalId when the account has one', async () => {
        mockStsSend.mockResolvedValue({ Credentials: { AccessKeyId: 'a', SecretAccessKey: 'b', SessionToken: 'c' } });
        await assumeAccountRole({ ...ACCOUNT, externalId: 'ext-1' }, 'us-east-1', 'session-1');
        expect(mockStsSend.mock.calls[0][0].input.ExternalId).toBe('ext-1');
    });

    it('returns null when the STS response is missing any credential field', async () => {
        mockStsSend.mockResolvedValue({ Credentials: { AccessKeyId: 'a' } });
        expect(await assumeAccountRole(ACCOUNT, 'us-east-1', 'session-1')).toBeNull();
    });

    it('returns null when Credentials itself is absent', async () => {
        mockStsSend.mockResolvedValue({});
        expect(await assumeAccountRole(ACCOUNT, 'us-east-1', 'session-1')).toBeNull();
    });
});

describe('acmClient', () => {
    it('constructs an ACMClient scoped to the given region and credentials', () => {
        const client = acmClient('eu-west-1', CREDS);
        expect(client).toBeDefined();
    });
});

describe('scanAccountCertificates', () => {
    it('lists then describes each certificate, normalizing the result', async () => {
        mockAcmSend.mockImplementation((cmd: { commandName: string }) => {
            if (cmd.commandName === 'ListCertificatesCommand') {
                return Promise.resolve({ CertificateSummaryList: [{ CertificateArn: 'arn:cert:1' }] });
            }
            if (cmd.commandName === 'DescribeCertificateCommand') {
                return Promise.resolve({
                    Certificate: {
                        CertificateArn: 'arn:cert:1', DomainName: 'example.com', SubjectAlternativeNames: ['example.com'],
                        NotAfter: new Date('2027-01-01'), Status: 'ISSUED', InUseBy: ['arn:elb:1'],
                    },
                });
            }
            throw new Error(`unexpected ${cmd.commandName}`);
        });

        const result = await scanAccountCertificates(CREDS, 'us-east-1');
        expect(result).toEqual([{
            arn: 'arn:cert:1', domainName: 'example.com', sans: ['example.com'],
            notAfter: new Date('2027-01-01'), status: 'ISSUED', inUseBy: ['arn:elb:1'],
        }]);
    });

    it('paginates across multiple NextToken pages', async () => {
        mockAcmSend.mockImplementation((cmd: { commandName: string; input: { NextToken?: string } }) => {
            if (cmd.commandName === 'ListCertificatesCommand') {
                if (!cmd.input.NextToken) return Promise.resolve({ CertificateSummaryList: [{ CertificateArn: 'arn:1' }], NextToken: 'page-2' });
                return Promise.resolve({ CertificateSummaryList: [{ CertificateArn: 'arn:2' }] });
            }
            return Promise.resolve({ Certificate: { CertificateArn: cmd.input.CertificateArn, DomainName: 'x.com' } });
        });

        const result = await scanAccountCertificates(CREDS, 'us-east-1');
        expect(result.map((r) => r.arn)).toEqual(['arn:1', 'arn:2']);
    });

    it('treats a ListCertificates response with no CertificateSummaryList key as empty', async () => {
        mockAcmSend.mockResolvedValue({});
        const result = await scanAccountCertificates(CREDS, 'us-east-1');
        expect(result).toEqual([]);
    });

    it('skips a summary entry with no ARN', async () => {
        mockAcmSend.mockImplementation((cmd: { commandName: string }) => {
            if (cmd.commandName === 'ListCertificatesCommand') return Promise.resolve({ CertificateSummaryList: [{}] });
            throw new Error('DescribeCertificate should not be called');
        });
        const result = await scanAccountCertificates(CREDS, 'us-east-1');
        expect(result).toEqual([]);
    });

    it('skips a describe result with no Certificate body', async () => {
        mockAcmSend.mockImplementation((cmd: { commandName: string }) => {
            if (cmd.commandName === 'ListCertificatesCommand') return Promise.resolve({ CertificateSummaryList: [{ CertificateArn: 'arn:1' }] });
            return Promise.resolve({});
        });
        const result = await scanAccountCertificates(CREDS, 'us-east-1');
        expect(result).toEqual([]);
    });

    it('continues scanning when describing one certificate throws', async () => {
        mockAcmSend.mockImplementation((cmd: { commandName: string; input: { CertificateArn?: string } }) => {
            if (cmd.commandName === 'ListCertificatesCommand') {
                return Promise.resolve({ CertificateSummaryList: [{ CertificateArn: 'arn:bad' }, { CertificateArn: 'arn:good' }] });
            }
            if (cmd.input.CertificateArn === 'arn:bad') return Promise.reject(new Error('access denied'));
            return Promise.resolve({ Certificate: { CertificateArn: 'arn:good', DomainName: 'good.com' } });
        });
        const result = await scanAccountCertificates(CREDS, 'us-east-1');
        expect(result).toEqual([{ arn: 'arn:good', domainName: 'good.com', sans: [], inUseBy: [] }]);
    });

    it('defaults domainName/sans/inUseBy and falls back to the summary ARN when the describe response omits them', async () => {
        mockAcmSend.mockImplementation((cmd: { commandName: string }) => {
            if (cmd.commandName === 'ListCertificatesCommand') return Promise.resolve({ CertificateSummaryList: [{ CertificateArn: 'arn:1' }] });
            return Promise.resolve({ Certificate: {} });
        });
        const [result] = await scanAccountCertificates(CREDS, 'us-east-1');
        expect(result).toEqual({ arn: 'arn:1', domainName: '', sans: [], inUseBy: [] });
    });
});

describe('describeAcmCertificate', () => {
    it('describes by ARN and returns the Certificate object', async () => {
        mockAcmSend.mockResolvedValue({ Certificate: { CertificateArn: 'arn:1', DomainName: 'x.com' } });
        const result = await describeAcmCertificate(CREDS, 'us-east-1', 'arn:1');
        expect(result).toEqual({ CertificateArn: 'arn:1', DomainName: 'x.com' });
        expect(mockAcmSend.mock.calls[0][0].input).toEqual({ CertificateArn: 'arn:1' });
    });
});

describe('scannedCertMatchesDomain', () => {
    it('matches an exact domain', () => {
        expect(scannedCertMatchesDomain({ arn: 'a', domainName: 'example.com', sans: [], inUseBy: [] }, 'example.com')).toBe(true);
    });

    it('matches via a SAN wildcard', () => {
        expect(scannedCertMatchesDomain({ arn: 'a', domainName: 'other.com', sans: ['*.example.com'], inUseBy: [] }, 'sub.example.com')).toBe(true);
    });

    it('does not match an unrelated domain', () => {
        expect(scannedCertMatchesDomain({ arn: 'a', domainName: 'other.com', sans: [], inUseBy: [] }, 'example.com')).toBe(false);
    });
});

describe('importToAcm', () => {
    it('imports body/privateKey as Buffers and returns the new ARN', async () => {
        mockAcmSend.mockResolvedValue({ CertificateArn: 'arn:new' });
        const result = await importToAcm(CREDS, 'us-east-1', { body: 'BODY', privateKey: 'KEY' });

        expect(result).toBe('arn:new');
        const input = mockAcmSend.mock.calls[0][0].input;
        expect(Buffer.isBuffer(input.Certificate)).toBe(true);
        expect(input.Certificate.toString()).toBe('BODY');
        expect(input).not.toHaveProperty('CertificateChain');
        expect(input).not.toHaveProperty('CertificateArn');
    });

    it('includes the chain and re-import ARN when provided', async () => {
        mockAcmSend.mockResolvedValue({ CertificateArn: 'arn:renewed' });
        await importToAcm(CREDS, 'us-east-1', { body: 'BODY', privateKey: 'KEY', chain: 'CHAIN', arn: 'arn:existing' });

        const input = mockAcmSend.mock.calls[0][0].input;
        expect(input.CertificateChain.toString()).toBe('CHAIN');
        expect(input.CertificateArn).toBe('arn:existing');
    });

    it('throws when ACM returns no ARN', async () => {
        mockAcmSend.mockResolvedValue({});
        await expect(importToAcm(CREDS, 'us-east-1', { body: 'BODY', privateKey: 'KEY' }))
            .rejects.toThrow('ACM ImportCertificate returned no ARN');
    });
});

describe('runBounded', () => {
    it('runs every task and returns fulfilled results in order', async () => {
        const tasks = [1, 2, 3].map((n) => () => Promise.resolve(n * 10));
        const results = await runBounded(tasks, 2);
        expect(results).toEqual([
            { status: 'fulfilled', value: 10 },
            { status: 'fulfilled', value: 20 },
            { status: 'fulfilled', value: 30 },
        ]);
    });

    it('captures a rejection per-task without aborting the batch', async () => {
        const tasks = [
            () => Promise.resolve('ok'),
            () => Promise.reject(new Error('boom')),
            () => Promise.resolve('ok2'),
        ];
        const results = await runBounded(tasks, 2);
        expect(results[0]).toEqual({ status: 'fulfilled', value: 'ok' });
        expect(results[1]).toMatchObject({ status: 'rejected' });
        expect(results[2]).toEqual({ status: 'fulfilled', value: 'ok2' });
    });

    it('never runs more than `concurrency` tasks at once', async () => {
        let active = 0;
        let maxActive = 0;
        const tasks = Array.from({ length: 10 }, () => async () => {
            active++;
            maxActive = Math.max(maxActive, active);
            await new Promise((r) => setTimeout(r, 5));
            active--;
            return 'done';
        });
        await runBounded(tasks, 3);
        expect(maxActive).toBeLessThanOrEqual(3);
    });

    it('caps concurrency at the task count for a small batch', async () => {
        const tasks = [() => Promise.resolve('a')];
        const results = await runBounded(tasks, 10);
        expect(results).toHaveLength(1);
    });

    it('resolves to an empty array for zero tasks', async () => {
        expect(await runBounded([], 5)).toEqual([]);
    });
});
