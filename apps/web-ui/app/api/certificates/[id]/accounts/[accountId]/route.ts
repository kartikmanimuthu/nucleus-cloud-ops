import { NextRequest, NextResponse } from 'next/server';
import { getCertificateRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';
import { getTenantClient } from '@/lib/db/pg-config';
import { assumeAccountRole, describeAcmCertificate } from '@/lib/certificate-aws';

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
    if (service === 'elasticloadbalancing') return { type: 'ALB/NLB', service: 'ELB' };
    if (service === 'cloudfront') return { type: 'Distribution', service: 'CloudFront' };
    if (service === 'apigateway') return { type: 'Domain Name', service: 'API Gateway' };
    if (service === 'execute-api') return { type: 'API', service: 'API Gateway' };
    if (service === 'cognito-idp') return { type: 'User Pool', service: 'Cognito' };
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
            return NextResponse.json({ success: false, error: 'Certificate not found' }, { status: 404 });
        }

        const db = getTenantClient(tenantId);
        const account = await db.account.findFirst({
            where: { tenantId, accountId },
            select: { accountId: true, name: true, roleArn: true, externalId: true, regions: true },
        });
        if (!account) {
            return NextResponse.json({ success: false, error: 'Account not found' }, { status: 404 });
        }

        // ACM ARN now comes from CertificateDeployment (live discovery), not inventory.
        const deployment = await repo.findDeployedInAccount(tenantId, certId, accountId);
        if (!deployment?.acmArn) {
            return NextResponse.json(
                {
                    success: false,
                    code: 'NOT_DISCOVERED',
                    error: 'This certificate has not been discovered or deployed in this account yet. Run Discover / Rescan, or Deploy to this account first.',
                },
                { status: 404 }
            );
        }

        const region = deployment.region && deployment.region !== 'unknown'
            ? deployment.region
            : account.regions[0] || 'us-east-1';

        const creds = await assumeAccountRole(
            { accountId, roleArn: account.roleArn, externalId: account.externalId },
            region,
            'cert-account-detail'
        );
        if (!creds) {
            return NextResponse.json(
                { success: false, error: 'Failed to assume role into target account' },
                { status: 500 }
            );
        }

        const c = await describeAcmCertificate(creds, region, deployment.acmArn);
        if (!c) {
            return NextResponse.json(
                { success: false, error: 'Certificate not found in ACM (it may have been deleted in the account — Rescan to refresh).' },
                { status: 404 }
            );
        }

        const resources: AssociatedResource[] = (c.InUseBy || []).map((arn) => {
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
                account: { accountId: account.accountId, name: account.name },
            },
        });
    } catch (error: unknown) {
        console.error('Error fetching ACM certificate info:', error);
        const message = error instanceof Error ? error.message : 'Failed to fetch certificate info';
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}
