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
    accountId: string;
    accountName: string;
    region: string;
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
            return NextResponse.json({ success: false, error: 'Certificate not found' }, { status: 404 });
        }

        // Use the discovered ACM ARNs (CertificateDeployment) — no inventory lookup.
        const deployments = (await repo.listDeployments(tenantId, id)).filter(d => d.acmArn);
        if (deployments.length === 0) {
            return NextResponse.json({ success: true, data: { resources: [] } });
        }

        const db = getTenantClient(tenantId);
        const accountIds = [...new Set(deployments.map(d => d.accountId))];
        const accounts = await db.account.findMany({
            where: { tenantId, accountId: { in: accountIds } },
            select: { accountId: true, name: true, roleArn: true, externalId: true },
        });
        const accountMeta = new Map(accounts.map(a => [a.accountId, a]));

        const allResources: AssociatedResource[] = [];
        for (const dep of deployments) {
            const meta = accountMeta.get(dep.accountId);
            if (!meta) continue;
            try {
                const creds = await assumeAccountRole(
                    { accountId: dep.accountId, roleArn: meta.roleArn, externalId: meta.externalId },
                    dep.region,
                    'cert-associated-resources'
                );
                if (!creds) continue;
                const desc = await describeAcmCertificate(creds, dep.region, dep.acmArn!);
                for (const arn of desc?.InUseBy ?? []) {
                    const { type, service } = parseResourceType(arn);
                    allResources.push({
                        arn,
                        type,
                        service,
                        accountId: dep.accountId,
                        accountName: meta.name ?? dep.accountId,
                        region: dep.region,
                    });
                }
            } catch (err) {
                console.error(`Error fetching InUseBy for account ${dep.accountId}/${dep.region}:`, err);
            }
        }

        return NextResponse.json({ success: true, data: { resources: allResources } });
    } catch (error: unknown) {
        console.error('Error fetching associated resources:', error);
        const message = error instanceof Error ? error.message : 'Failed to fetch associated resources';
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}
