/**
 * Server-only helper centralizing cross-account ACM access for the Certificate
 * Manager. Replaces the STS/ACM logic previously inlined across the certificate
 * API routes, and the inventory-based correlation (now we scan ACM directly).
 */
import {
    ACMClient,
    ListCertificatesCommand,
    DescribeCertificateCommand,
    ImportCertificateCommand,
} from '@aws-sdk/client-acm';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { domainMatches } from '@/lib/certificate-utils';

export const DEFAULT_REGION = process.env.AWS_REGION || 'ap-south-1';

export interface AcmCredentials {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
}

export interface AccountRef {
    accountId: string;
    roleArn: string;
    externalId?: string | null;
    regions?: string[];
}

export interface ScannedAcmCert {
    arn: string;
    domainName: string;
    sans: string[];
    notAfter?: Date;
    status?: string;
    inUseBy: string[];
}

/** Assume the account's cross-account role and return temporary credentials. */
export async function assumeAccountRole(
    account: AccountRef,
    region: string,
    sessionName: string
): Promise<AcmCredentials | null> {
    const sts = new STSClient({ region });
    const { Credentials } = await sts.send(
        new AssumeRoleCommand({
            RoleArn: account.roleArn,
            RoleSessionName: sessionName,
            DurationSeconds: 3600,
            ...(account.externalId ? { ExternalId: account.externalId } : {}),
        })
    );
    if (!Credentials?.AccessKeyId || !Credentials.SecretAccessKey || !Credentials.SessionToken) {
        return null;
    }
    return {
        accessKeyId: Credentials.AccessKeyId,
        secretAccessKey: Credentials.SecretAccessKey,
        sessionToken: Credentials.SessionToken,
    };
}

export function acmClient(region: string, credentials: AcmCredentials): ACMClient {
    return new ACMClient({ region, credentials });
}

/**
 * List + describe all ACM certificates in one account/region. Returns normalized
 * records including expiry, status, and the resources each cert is in use by.
 */
export async function scanAccountCertificates(
    credentials: AcmCredentials,
    region: string
): Promise<ScannedAcmCert[]> {
    const acm = acmClient(region, credentials);
    const results: ScannedAcmCert[] = [];
    let nextToken: string | undefined;

    do {
        const list = await acm.send(new ListCertificatesCommand({ NextToken: nextToken, MaxItems: 100 }));
        nextToken = list.NextToken;
        for (const summary of list.CertificateSummaryList ?? []) {
            if (!summary.CertificateArn) continue;
            try {
                const { Certificate } = await acm.send(
                    new DescribeCertificateCommand({ CertificateArn: summary.CertificateArn })
                );
                if (!Certificate) continue;
                results.push({
                    arn: Certificate.CertificateArn ?? summary.CertificateArn,
                    domainName: Certificate.DomainName ?? '',
                    sans: Certificate.SubjectAlternativeNames ?? [],
                    notAfter: Certificate.NotAfter,
                    status: Certificate.Status,
                    inUseBy: Certificate.InUseBy ?? [],
                });
            } catch {
                // Skip certs we cannot describe; continue scanning the rest.
            }
        }
    } while (nextToken);

    return results;
}

/** Describe a single ACM certificate by ARN (used for live InUseBy lookups). */
export async function describeAcmCertificate(
    credentials: AcmCredentials,
    region: string,
    arn: string
) {
    const acm = acmClient(region, credentials);
    const { Certificate } = await acm.send(new DescribeCertificateCommand({ CertificateArn: arn }));
    return Certificate;
}

/** True if a scanned ACM cert corresponds to the managed certificate's domain. */
export function scannedCertMatchesDomain(cert: ScannedAcmCert, managedDomain: string): boolean {
    return domainMatches(managedDomain, cert.domainName, cert.sans);
}

export interface ImportMaterial {
    body: string;
    privateKey: string;
    chain?: string;
    /** When provided, re-imports in place (renews the same ACM ARN). */
    arn?: string;
}

/** Import (or re-import in place) certificate material into ACM. Returns the ARN. */
export async function importToAcm(
    credentials: AcmCredentials,
    region: string,
    material: ImportMaterial
): Promise<string> {
    const acm = acmClient(region, credentials);
    const result = await acm.send(
        new ImportCertificateCommand({
            Certificate: Buffer.from(material.body),
            PrivateKey: Buffer.from(material.privateKey),
            ...(material.chain ? { CertificateChain: Buffer.from(material.chain) } : {}),
            ...(material.arn ? { CertificateArn: material.arn } : {}),
        })
    );
    if (!result.CertificateArn) {
        throw new Error('ACM ImportCertificate returned no ARN');
    }
    return result.CertificateArn;
}

/**
 * Minimal concurrency limiter (no external dependency). Runs `tasks` with at most
 * `concurrency` in flight; never rejects (mirrors Promise.allSettled semantics so a
 * single failed task does not abort the batch).
 */
export async function runBounded<T>(
    tasks: Array<() => Promise<T>>,
    concurrency: number
): Promise<PromiseSettledResult<T>[]> {
    const results: PromiseSettledResult<T>[] = new Array(tasks.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
        while (cursor < tasks.length) {
            const index = cursor++;
            try {
                results[index] = { status: 'fulfilled', value: await tasks[index]() };
            } catch (reason) {
                results[index] = { status: 'rejected', reason };
            }
        }
    });
    await Promise.all(workers);
    return results;
}
