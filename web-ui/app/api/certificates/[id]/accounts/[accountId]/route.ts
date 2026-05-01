import { NextRequest, NextResponse } from 'next/server';
import { getCertificateRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';
import { getTenantClient } from '@/lib/db/pg-config';
import { ACMClient, DescribeCertificateCommand } from '@aws-sdk/client-acm';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';

interface AssociatedResource {
    arn: string;
    type: string;
    service: string;
}

function parseResourceType(arn: string): { type: string; service: string } {
    const parts = arn.split(':');
    if (parts.length < 6) return { type: 'Unknown', service: 'Unknown' };
    const service = parts[2];
    const resourceType = parts[5]?.split('/')[0] || '';

    if (service === 'elasticloadbalancing') {
        return { type: 'ALB/NLB', service: 'ELB' };
    }
    if (service === 'cloudfront') {
        return { type: 'Distribution', service: 'CloudFront' };
    }
    if (service === 'apigateway') {
        return { type: 'Domain Name', service: 'API Gateway' };
    }
    if (service === 'execute-api') {
        return { type: 'API', service: 'API Gateway' };
    }
    if (service === 'cognito-idp') {
        return { type: 'User Pool', service: 'Cognito' };
    }
    return { type: resourceType || 'Unknown', service: service || 'Unknown' };
}

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string; accountId: string }> }
) {
    try {
        const tenantId = await getSessionTenantId();
        const authError = await authorize('read', 'Certificate');
        if (authError) return authError;

        const { id: certId, accountId } = await params;
        const repo = getCertificateRepository();
        const cert = await repo.getCertificate(tenantId, certId);

        if (!cert) {
            return NextResponse.json(
                { success: false, error: 'Certificate not found' },
                { status: 404 }
            );
        }

        const db = getTenantClient(tenantId);

        // Get account details
        const account = await db.account.findFirst({
            where: { tenantId, accountId },
            select: {
                accountId: true,
                name: true,
                roleArn: true,
                externalId: true,
                regions: true,
            },
        });

        if (!account) {
            return NextResponse.json(
                { success: false, error: 'Account not found' },
                { status: 404 }
            );
        }

        // Find matching ACM certificate ARN from inventory
        const acmResources = await db.inventoryResource.findMany({
            where: {
                tenantId,
                accountId,
                resourceType: 'acm_certificates',
            },
            select: {
                resourceId: true,
                metadata: true,
            },
        });

        const matchingAcmCert = acmResources.find((r) => {
            const meta = r.metadata as Record<string, unknown>;
            return (
                (meta?.domainName as string || '').toLowerCase() ===
                cert.domainName.toLowerCase()
            );
        });

        if (!matchingAcmCert) {
            return NextResponse.json(
                { success: false, error: 'ACM certificate not found in this account' },
                { status: 404 }
            );
        }

        const certArn = matchingAcmCert.resourceId;

        // STS AssumeRole into the account
        const stsClient = new STSClient({
            region: account.regions[0] || 'us-east-1',
        });
        const { Credentials } = await stsClient.send(
            new AssumeRoleCommand({
                RoleArn: account.roleArn,
                RoleSessionName: 'cert-account-detail',
                ...(account.externalId ? { ExternalId: account.externalId } : {}),
            })
        );

        if (!Credentials) {
            return NextResponse.json(
                { success: false, error: 'Failed to assume role into target account' },
                { status: 500 }
            );
        }

        const acmClient = new ACMClient({
            region: account.regions[0] || 'us-east-1',
            credentials: {
                accessKeyId: Credentials.AccessKeyId!,
                secretAccessKey: Credentials.SecretAccessKey!,
                sessionToken: Credentials.SessionToken!,
            },
        });

        const desc = await acmClient.send(
            new DescribeCertificateCommand({
                CertificateArn: certArn,
            })
        );

        const c = desc.Certificate;
        if (!c) {
            return NextResponse.json(
                { success: false, error: 'Certificate not found in ACM' },
                { status: 404 }
            );
        }

        const inUseBy = c.InUseBy || [];
        const resources: AssociatedResource[] = inUseBy.map((arn) => {
            const { type, service } = parseResourceType(arn);
            return { arn, type, service };
        });

        return NextResponse.json({
            success: true,
            data: {
                certificate: {
                    arn: c.CertificateArn,
                    status: c.Status,
                    domainName: c.DomainName,
                    issuer: c.Issuer,
                    notBefore: c.NotBefore?.toISOString(),
                    notAfter: c.NotAfter?.toISOString(),
                    serial: c.Serial,
                    signatureAlgorithm: c.SignatureAlgorithm,
                    type: c.Type,
                    importedAt: c.ImportedAt?.toISOString(),
                    inUseBy: resources,
                },
                account: {
                    accountId: account.accountId,
                    name: account.name,
                },
            },
        });
    } catch (error: unknown) {
        console.error('Error fetching ACM certificate info:', error);
        const message =
            error instanceof Error ? error.message : 'Failed to fetch certificate info';
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}
