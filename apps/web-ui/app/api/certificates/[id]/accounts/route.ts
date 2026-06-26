import { NextRequest, NextResponse } from 'next/server';
import { getCertificateRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { getTenantClient } from '@/lib/db/pg-config';

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const tenantId = await getSessionTenantId();
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
            return NextResponse.json({ success: true, data: { accounts: [] } });
        }

        const accounts = await db.account.findMany({
            where: {
                tenantId,
                accountId: { in: cert.associatedAccountIds },
            },
            select: {
                accountId: true,
                name: true,
                regions: true,
                connectionStatus: true,
            },
        });

        const resources = await db.inventoryResource.findMany({
            where: {
                tenantId,
                resourceType: 'acm_certificates',
            },
            select: {
                accountId: true,
                resourceId: true,
                name: true,
                region: true,
                metadata: true,
            },
        });

        const accountsWithResources = accounts.map(account => {
            const accountResources = resources.filter(
                r =>
                    r.accountId === account.accountId &&
                    ((r.metadata as Record<string, unknown>)?.domainName as string || '')
                        .toLowerCase() === cert.domainName.toLowerCase()
            );
            return {
                accountId: account.accountId,
                accountName: account.name,
                regions: account.regions,
                connectionStatus: account.connectionStatus,
                resourceCount: accountResources.length,
                resources: accountResources.map(r => ({
                    resourceId: r.resourceId,
                    name: r.name,
                    region: r.region,
                    resourceType: 'acm_certificate',
                })),
            };
        });

        return NextResponse.json({ success: true, data: { accounts: accountsWithResources } });
    } catch (error: unknown) {
        console.error('Error fetching certificate accounts:', error);
        const message = error instanceof Error ? error.message : 'Failed to fetch accounts';
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}
