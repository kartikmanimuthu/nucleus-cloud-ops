import { PrismaClient } from '@prisma/client';
import { ACMClient, DescribeCertificateCommand } from '@aws-sdk/client-acm';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { createLogger } from '../../lib/logger';

const logger = createLogger('certificate-expiry-monitor');
const DAY_MS = 86_400_000;

/** Mirror of web-ui computeExpiryStatus (workers cannot import from web-ui). */
function computeStatus(notAfter: Date): 'active' | 'expiring' | 'expired' {
    const days = Math.ceil((notAfter.getTime() - Date.now()) / DAY_MS);
    if (days < 0) return 'expired';
    if (days <= 60) return 'expiring';
    return 'active';
}

interface Creds {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
}

/**
 * Daily reconciliation:
 *  1. Refresh ACM data on every discovered/deployed CertificateDeployment (live DescribeCertificate),
 *     keeping the cached per-account expiry in the UI fresh (complements manual Rescan).
 *  2. Recompute CertificateVersion.status from notAfter.
 *  3. Recompute the cached Certificate.status/notAfter/issuer from the active version.
 *
 * No dependence on inventoryResource — the Certificate Manager owns its own linkage.
 */
export async function handleCertificateExpiryMonitor(): Promise<void> {
    logger.info('Starting certificate expiry monitor');
    const db = new PrismaClient();

    try {
        // --- 1. Refresh ACM deployment data ---
        const deployments = await db.certificateDeployment.findMany({
            where: { acmArn: { not: null } },
        });
        logger.info(`Refreshing ${deployments.length} certificate deployment(s)`);

        const credCache = new Map<string, Creds | null>();
        const stsClients = new Map<string, STSClient>();

        for (const dep of deployments) {
            try {
                const account = await db.account.findFirst({
                    where: { tenantId: dep.tenantId, accountId: dep.accountId },
                    select: { roleArn: true, externalId: true },
                });
                if (!account) {
                    await db.certificateDeployment.update({
                        where: { id: dep.id },
                        data: { linkState: 'error', lastScannedAt: new Date() },
                    });
                    continue;
                }

                const cacheKey = `${dep.tenantId}:${dep.accountId}:${dep.region}`;
                let creds = credCache.get(cacheKey);
                if (creds === undefined) {
                    const sts =
                        stsClients.get(dep.region) ?? new STSClient({ region: dep.region });
                    stsClients.set(dep.region, sts);
                    const { Credentials } = await sts.send(
                        new AssumeRoleCommand({
                            RoleArn: account.roleArn,
                            RoleSessionName: 'cert-expiry-monitor',
                            ...(account.externalId ? { ExternalId: account.externalId } : {}),
                        })
                    );
                    creds = Credentials?.AccessKeyId
                        ? {
                              accessKeyId: Credentials.AccessKeyId,
                              secretAccessKey: Credentials.SecretAccessKey!,
                              sessionToken: Credentials.SessionToken!,
                          }
                        : null;
                    credCache.set(cacheKey, creds);
                }

                if (!creds) {
                    await db.certificateDeployment.update({
                        where: { id: dep.id },
                        data: { linkState: 'error', lastScannedAt: new Date() },
                    });
                    continue;
                }

                const acm = new ACMClient({ region: dep.region, credentials: creds });
                const { Certificate } = await acm.send(
                    new DescribeCertificateCommand({ CertificateArn: dep.acmArn! })
                );

                await db.certificateDeployment.update({
                    where: { id: dep.id },
                    data: {
                        acmNotAfter: Certificate?.NotAfter ?? null,
                        acmStatus: Certificate?.Status ?? null,
                        inUseByCount: Certificate?.InUseBy?.length ?? 0,
                        linkState: Certificate ? 'deployed' : 'missing',
                        lastScannedAt: new Date(),
                    },
                });
            } catch (err) {
                logger.warn(`Could not refresh deployment ${dep.id}: ${err}`);
                await db.certificateDeployment
                    .update({
                        where: { id: dep.id },
                        data: { linkState: 'missing', lastScannedAt: new Date() },
                    })
                    .catch(() => undefined);
            }
        }

        // --- 2. Recompute version statuses ---
        const versions = await db.certificateVersion.findMany({
            select: { id: true, notAfter: true, status: true },
        });
        for (const v of versions) {
            const next = computeStatus(v.notAfter);
            if (next !== v.status) {
                await db.certificateVersion.update({ where: { id: v.id }, data: { status: next } });
            }
        }

        // --- 3. Recompute cached certificate status from the active version ---
        const certs = await db.certificate.findMany({
            where: { activeVersionId: { not: null } },
            select: { id: true, tenantId: true, activeVersionId: true, status: true },
        });
        for (const c of certs) {
            const active = await db.certificateVersion.findFirst({
                where: { tenantId: c.tenantId, id: c.activeVersionId! },
                select: { notAfter: true, issuer: true, notBefore: true },
            });
            if (!active) continue;
            const next = computeStatus(active.notAfter);
            await db.certificate.update({
                where: { id: c.id },
                data: {
                    status: next,
                    notAfter: active.notAfter,
                    notBefore: active.notBefore,
                    issuer: active.issuer,
                },
            });
        }

        logger.info('Certificate expiry monitor complete');
    } catch (err) {
        logger.error(`Certificate expiry monitor failed: ${err}`);
        throw err;
    } finally {
        await db.$disconnect();
    }
}
