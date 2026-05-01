import { NextRequest, NextResponse } from 'next/server';
import { getCertificateRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { getTenantClient } from '@/lib/db/pg-config';

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const tenantId = await getSessionTenantId();

        const repo = getCertificateRepository();
        const result = await repo.listCertificates({
            tenantId,
            status: searchParams.get('status') as 'active' | 'expiring' | 'expired' | undefined,
            searchTerm: searchParams.get('search') || undefined,
            limit: parseInt(searchParams.get('limit') || '50', 10),
            page: parseInt(searchParams.get('page') || '1', 10),
        });

        const distinctAccountIds = [
            ...new Set(result.certificates.flatMap(c => c.associatedAccountIds)),
        ];
        const accountNameMap: Record<string, string> = {};
        if (distinctAccountIds.length > 0) {
            try {
                const accounts = await getTenantClient(tenantId).account.findMany({
                    where: { tenantId, accountId: { in: distinctAccountIds } },
                    select: { accountId: true, name: true },
                });
                for (const a of accounts) {
                    if (a.name) accountNameMap[a.accountId] = a.name;
                }
            } catch (e) {
                console.warn('Could not fetch account names for certificates:', e);
            }
        }

        const certificates = result.certificates.map(c => ({
            ...c,
            associatedAccountNames: c.associatedAccountIds
                .map(id => accountNameMap[id] || id)
                .filter(Boolean),
        }));

        return NextResponse.json({
            success: true,
            data: certificates,
            total: result.total,
        });
    } catch (error: unknown) {
        console.error('Error fetching certificates:', error);
        const message = error instanceof Error ? error.message : 'Failed to fetch certificates';
        if (message.includes('Unauthenticated')) {
            return NextResponse.json({ success: false, error: message }, { status: 401 });
        }
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}
