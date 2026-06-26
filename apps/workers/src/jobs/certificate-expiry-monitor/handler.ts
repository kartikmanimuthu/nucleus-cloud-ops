import { PrismaClient } from '@prisma/client';
import { ACMClient, DescribeCertificateCommand } from '@aws-sdk/client-acm';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { createLogger } from '../../lib/logger';

const logger = createLogger('certificate-expiry-monitor');

export async function handleCertificateExpiryMonitor(): Promise<void> {
    logger.info('Starting certificate expiry monitor');

    const db = new PrismaClient();
    const sixtyDaysFromNow = new Date(Date.now() + 60 * 86400000);

    try {
        const certificates = await db.certificate.findMany({
            where: {
                notAfter: { lte: sixtyDaysFromNow },
                status: { in: ['active', 'expiring'] },
                associatedAccountIds: { isEmpty: false },
            },
        });

        logger.info(`Found ${certificates.length} certificates expiring within 60 days`);

        for (const cert of certificates) {
            for (const accountId of cert.associatedAccountIds) {
                try {
                    const account = await db.account.findFirst({
                        where: { tenantId: cert.tenantId, accountId },
                        select: { roleArn: true, externalId: true, regions: true },
                    });

                    if (!account) {
                        logger.warn(`Account ${accountId} not found for cert ${cert.id}`);
                        continue;
                    }

                    const stsClient = new STSClient({ region: account.regions[0] || 'us-east-1' });
                    const assumeCommand = new AssumeRoleCommand({
                        RoleArn: account.roleArn,
                        RoleSessionName: 'cert-expiry-monitor',
                        ...(account.externalId ? { ExternalId: account.externalId } : {}),
                    });
                    const { Credentials } = await stsClient.send(assumeCommand);

                    if (!Credentials) {
                        logger.warn(`Could not assume role for account ${accountId}`);
                        continue;
                    }

                    const acmClient = new ACMClient({
                        region: account.regions[0] || 'us-east-1',
                        credentials: {
                            accessKeyId: Credentials.AccessKeyId!,
                            secretAccessKey: Credentials.SecretAccessKey!,
                            sessionToken: Credentials.SessionToken!,
                        },
                    });

                    const acmCerts = await db.inventoryResource.findMany({
                        where: {
                            tenantId: cert.tenantId,
                            accountId,
                            resourceType: 'acm_certificates',
                        },
                        select: { resourceId: true, metadata: true },
                    });

                    for (const acmCert of acmCerts) {
                        const metaDomain = (acmCert.metadata as Record<string, unknown>)?.domainName as string;
                        if (metaDomain?.toLowerCase() !== cert.domainName.toLowerCase()) continue;

                        try {
                            const desc = await acmClient.send(
                                new DescribeCertificateCommand({
                                    CertificateArn: acmCert.resourceId,
                                })
                            );
                            logger.info(
                                `Cert ${cert.name} in account ${accountId}: ACM status=${desc.Certificate?.Status}, ACM expiry=${desc.Certificate?.NotAfter}`
                            );
                        } catch (acmErr) {
                            logger.warn(`Could not describe ACM cert ${acmCert.resourceId}: ${acmErr}`);
                        }
                    }
                } catch (err) {
                    logger.error(`Error processing account ${accountId} for cert ${cert.id}: ${err}`);
                }
            }
        }

        // Update status for expired certs
        const now = new Date();
        const expiredResult = await db.certificate.updateMany({
            where: { notAfter: { lt: now }, status: { not: 'expired' } },
            data: { status: 'expired' },
        });
        if (expiredResult.count > 0) {
            logger.info(`Updated ${expiredResult.count} certificates to 'expired'`);
        }

        // Update status for expiring certs
        const expiringResult = await db.certificate.updateMany({
            where: { notAfter: { gte: now, lte: sixtyDaysFromNow }, status: 'active' },
            data: { status: 'expiring' },
        });
        if (expiringResult.count > 0) {
            logger.info(`Updated ${expiringResult.count} certificates to 'expiring'`);
        }

        logger.info('Certificate expiry monitor complete');
    } catch (err) {
        logger.error(`Certificate expiry monitor failed: ${err}`);
        throw err;
    } finally {
        await db.$disconnect();
    }
}
