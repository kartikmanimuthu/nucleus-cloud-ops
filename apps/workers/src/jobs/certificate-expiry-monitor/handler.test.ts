import { describe, it, expect, vi, beforeEach } from 'vitest';

const { db, mockStsSend, mockAcmSend } = vi.hoisted(() => ({
    db: {
        certificateDeployment: { findMany: vi.fn(), update: vi.fn() },
        account: { findFirst: vi.fn() },
        certificateVersion: { findMany: vi.fn(), update: vi.fn(), findFirst: vi.fn() },
        certificate: { findMany: vi.fn(), update: vi.fn() },
        $disconnect: vi.fn().mockResolvedValue(undefined),
    },
    mockStsSend: vi.fn(),
    mockAcmSend: vi.fn(),
}));

vi.mock('@prisma/client', () => ({ PrismaClient: vi.fn().mockImplementation(() => db) }));
vi.mock('@aws-sdk/client-sts', () => ({
    STSClient: vi.fn().mockImplementation(function (this: any) { this.send = mockStsSend; }),
    AssumeRoleCommand: vi.fn().mockImplementation(function (this: any, input: unknown) { this.input = input; }),
}));
vi.mock('@aws-sdk/client-acm', () => ({
    ACMClient: vi.fn().mockImplementation(function (this: any) { this.send = mockAcmSend; }),
    DescribeCertificateCommand: vi.fn().mockImplementation(function (this: any, input: unknown) { this.input = input; }),
}));

import { handleCertificateExpiryMonitor } from './handler.js';

const account = { roleArn: 'arn:aws:iam::123:role/cert-scan', externalId: null };
const deployment = { id: 'dep-1', tenantId: 't1', accountId: '123', region: 'us-east-1', acmArn: 'arn:aws:acm:us-east-1:123:certificate/abc' };
const assumeRoleOk = { Credentials: { AccessKeyId: 'ak', SecretAccessKey: 'sk', SessionToken: 'st' } };

function daysFromNow(days: number): Date {
    return new Date(Date.now() + days * 86_400_000);
}

beforeEach(() => {
    vi.clearAllMocks();
    db.certificateDeployment.findMany.mockResolvedValue([]);
    db.certificateDeployment.update.mockResolvedValue(undefined);
    db.certificateVersion.findMany.mockResolvedValue([]);
    db.certificateVersion.update.mockResolvedValue(undefined);
    db.certificate.findMany.mockResolvedValue([]);
    db.certificate.update.mockResolvedValue(undefined);
    db.account.findFirst.mockResolvedValue(account);
    mockStsSend.mockResolvedValue(assumeRoleOk);
    mockAcmSend.mockResolvedValue({ Certificate: { NotAfter: daysFromNow(90), Status: 'ISSUED', InUseBy: ['arn1'] } });
});

describe('handleCertificateExpiryMonitor — deployment refresh', () => {
    it('refreshes a deployment from a live ACM describe and marks it deployed', async () => {
        db.certificateDeployment.findMany.mockResolvedValue([deployment]);

        await handleCertificateExpiryMonitor();

        expect(db.certificateDeployment.update).toHaveBeenCalledWith({
            where: { id: 'dep-1' },
            data: expect.objectContaining({ acmStatus: 'ISSUED', inUseByCount: 1, linkState: 'deployed' }),
        });
    });

    it('marks the deployment errored when the owning account cannot be found', async () => {
        db.certificateDeployment.findMany.mockResolvedValue([deployment]);
        db.account.findFirst.mockResolvedValue(null);

        await handleCertificateExpiryMonitor();

        expect(db.certificateDeployment.update).toHaveBeenCalledWith({ where: { id: 'dep-1' }, data: expect.objectContaining({ linkState: 'error' }) });
        expect(mockStsSend).not.toHaveBeenCalled();
    });

    it('marks the deployment errored when AssumeRole returns no credentials', async () => {
        db.certificateDeployment.findMany.mockResolvedValue([deployment]);
        mockStsSend.mockResolvedValue({ Credentials: undefined });

        await handleCertificateExpiryMonitor();

        expect(db.certificateDeployment.update).toHaveBeenCalledWith({ where: { id: 'dep-1' }, data: expect.objectContaining({ linkState: 'error' }) });
        expect(mockAcmSend).not.toHaveBeenCalled();
    });

    it('caches assumed-role credentials across deployments sharing the same tenant/account/region', async () => {
        const dep2 = { ...deployment, id: 'dep-2', acmArn: 'arn:aws:acm:us-east-1:123:certificate/def' };
        db.certificateDeployment.findMany.mockResolvedValue([deployment, dep2]);

        await handleCertificateExpiryMonitor();

        expect(mockStsSend).toHaveBeenCalledTimes(1);
        expect(db.certificateDeployment.update).toHaveBeenCalledTimes(2);
    });

    it('marks the deployment missing when ACM reports no certificate', async () => {
        db.certificateDeployment.findMany.mockResolvedValue([deployment]);
        mockAcmSend.mockResolvedValue({ Certificate: undefined });

        await handleCertificateExpiryMonitor();

        expect(db.certificateDeployment.update).toHaveBeenCalledWith({ where: { id: 'dep-1' }, data: expect.objectContaining({ linkState: 'missing' }) });
    });

    it('recovers from a per-deployment ACM failure and continues to the next deployment', async () => {
        const dep2 = { ...deployment, id: 'dep-2' };
        db.certificateDeployment.findMany.mockResolvedValue([deployment, dep2]);
        mockAcmSend.mockRejectedValueOnce(new Error('AccessDenied')).mockResolvedValueOnce({ Certificate: { NotAfter: daysFromNow(90), Status: 'ISSUED' } });

        await handleCertificateExpiryMonitor();

        expect(db.certificateDeployment.update).toHaveBeenCalledWith({ where: { id: 'dep-1' }, data: expect.objectContaining({ linkState: 'missing' }) });
        expect(db.certificateDeployment.update).toHaveBeenCalledWith({ where: { id: 'dep-2' }, data: expect.objectContaining({ linkState: 'deployed' }) });
    });

    it('swallows a failure in the fallback error-marking update itself', async () => {
        db.certificateDeployment.findMany.mockResolvedValue([deployment]);
        mockAcmSend.mockRejectedValue(new Error('AccessDenied'));
        db.certificateDeployment.update.mockRejectedValue(new Error('db unavailable'));

        await expect(handleCertificateExpiryMonitor()).resolves.toBeUndefined();
    });
});

describe('handleCertificateExpiryMonitor — version status recompute', () => {
    it('updates a version whose computed status has changed', async () => {
        db.certificateVersion.findMany.mockResolvedValue([{ id: 'v1', notAfter: daysFromNow(-5), status: 'active' }]);
        await handleCertificateExpiryMonitor();
        expect(db.certificateVersion.update).toHaveBeenCalledWith({ where: { id: 'v1' }, data: { status: 'expired' } });
    });

    it('leaves a version untouched when its computed status has not changed', async () => {
        db.certificateVersion.findMany.mockResolvedValue([{ id: 'v1', notAfter: daysFromNow(400), status: 'active' }]);
        await handleCertificateExpiryMonitor();
        expect(db.certificateVersion.update).not.toHaveBeenCalled();
    });

    it('classifies a certificate expiring within 60 days as "expiring"', async () => {
        db.certificateVersion.findMany.mockResolvedValue([{ id: 'v1', notAfter: daysFromNow(30), status: 'active' }]);
        await handleCertificateExpiryMonitor();
        expect(db.certificateVersion.update).toHaveBeenCalledWith({ where: { id: 'v1' }, data: { status: 'expiring' } });
    });
});

describe('handleCertificateExpiryMonitor — cached certificate recompute', () => {
    it('refreshes the cached certificate from its active version', async () => {
        db.certificate.findMany.mockResolvedValue([{ id: 'c1', tenantId: 't1', activeVersionId: 'v1', status: 'active' }]);
        const notAfter = daysFromNow(400);
        db.certificateVersion.findFirst.mockResolvedValue({ notAfter, issuer: 'Let\'s Encrypt', notBefore: daysFromNow(-30) });

        await handleCertificateExpiryMonitor();

        expect(db.certificate.update).toHaveBeenCalledWith({
            where: { id: 'c1' },
            data: expect.objectContaining({ status: 'active', notAfter, issuer: 'Let\'s Encrypt' }),
        });
    });

    it('skips a certificate whose active version cannot be found', async () => {
        db.certificate.findMany.mockResolvedValue([{ id: 'c1', tenantId: 't1', activeVersionId: 'v1', status: 'active' }]);
        db.certificateVersion.findFirst.mockResolvedValue(null);

        await handleCertificateExpiryMonitor();

        expect(db.certificate.update).not.toHaveBeenCalled();
    });

    it('scopes the active-version lookup by tenantId (multi-tenant safety)', async () => {
        db.certificate.findMany.mockResolvedValue([{ id: 'c1', tenantId: 't1', activeVersionId: 'v1', status: 'active' }]);
        db.certificateVersion.findFirst.mockResolvedValue({ notAfter: daysFromNow(400), issuer: 'CA', notBefore: daysFromNow(-30) });

        await handleCertificateExpiryMonitor();

        expect(db.certificateVersion.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tenantId: 't1' }) }));
    });
});

describe('handleCertificateExpiryMonitor — top-level failure', () => {
    it('rethrows and still disconnects when a top-level query fails', async () => {
        db.certificateDeployment.findMany.mockRejectedValue(new Error('connection refused'));
        await expect(handleCertificateExpiryMonitor()).rejects.toThrow('connection refused');
        expect(db.$disconnect).toHaveBeenCalled();
    });
});
