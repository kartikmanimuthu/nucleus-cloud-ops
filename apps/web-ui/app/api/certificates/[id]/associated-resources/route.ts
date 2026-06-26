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
    accountId: string;
    accountName: string;
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
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const tenantId = await getSessionTenantId();
        const authError = await authorize('read', 'Certificate');
        if (authError) return authError;

        const { id } = await params;
        const repo = getCertificateRepository();
        const cert = await repo.getCertificate(tenantId, id);

        if (!cert) {
            return NextResponse.json(
                { success: false, error: 'Certificate not found' },
                { status: 404 }
            );
        }

        const db = getTenantClient(tenantId);

        if (cert.associatedAccountIds.length === 0) {
            return NextResponse.json({ success: true, data: { resources: [] } });
        }

        // Get account details
        const accounts = await db.account.findMany({
            where: {
                tenantId,
                accountId: { in: cert.associatedAccountIds },
            },
            select: {
                accountId: true,
                name: true,
                roleArn: true,
                externalId: true,
                regions: true,
            },
        });

        const accountNameMap: Record<string, string> = {};
        for (const a of accounts) {
            accountNameMap[a.accountId] = a.name || a.accountId;
        }

        // Find matching ACM certificate ARNs per account
        const acmResources = await db.inventoryResource.findMany({
            where: {
                tenantId,
                resourceType: 'acm_certificates',
                accountId: { in: cert.associatedAccountIds },
            },
            select: {
                accountId: true,
                resourceId: true,
                metadata: true,
            },
        });

        const certArnMap: Record<string, string> = {};
        for (const r of acmResources) {
            const meta = r.metadata as Record<string, unknown> | null;
            const metaDomain = (meta?.domainName as string) || '';
            if (metaDomain.toLowerCase() === cert.domainName.toLowerCase()) {
                certArnMap[r.accountId] = r.resourceId;
            }
        }

        const allResources: AssociatedResource[] = [];

        for (const account of accounts) {
            const certArn = certArnMap[account.accountId];
            if (!certArn) {
                continue;
            }

            try {
                const stsClient = new STSClient({
                    region: account.regions[0] || 'us-east-1',
                });
                const { Credentials } = await stsClient.send(
                    new AssumeRoleCommand({
                        RoleArn: account.roleArn,
                        RoleSessionName: 'cert-associated-resources',
                        ...(account.externalId ? { ExternalId: account.externalId } : {}),
                    })
                );

                if (!Credentials) {
                    console.warn(`Could not assume role for account ${account.accountId}`);
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

                const desc = await acmClient.send(
                    new DescribeCertificateCommand({
                        CertificateArn: certArn,
                    })
                );

                const inUseBy = desc.Certificate?.InUseBy || [];
                for (const arn of inUseBy) {
                    const { type, service } = parseResourceType(arn);
                    allResources.push({
                        arn,
                        type,
                        service,
                        accountId: account.accountId,
                        accountName: accountNameMap[account.accountId] || account.accountId,
                    });
                }
            } catch (err) {
                console.error(
                    `Error fetching associated resources for account ${account.accountId}:`
                    , err
                );
            }
        }

        return NextResponse.json({
            success: true,
            data: { resources: allResources },
        });
    } catch (error: unknown) {
        console.error('Error fetching associated resources:', error);
        const message = error instanceof Error ? error.message : 'Failed to fetch associated resources';
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}
