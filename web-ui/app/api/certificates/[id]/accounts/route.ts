import { NextRequest, NextResponse } from 'next/server';
import { getCertificateRepository } from '@/lib/db/repository-factory';
import { getSessionTenantId } from '@/lib/auth-session';
import { authorize } from '@/lib/rbac/authorize';
import { getTenantClient } from '@/lib/db/pg-config';

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

        const deployments = await repo.listDeployments(tenantId, id);
        if (deployments.length === 0) {
            return NextResponse.json({ success: true, data: { accounts: [] } });
        }

        const db = getTenantClient(tenantId);
        const accountIds = [...new Set(deployments.map(d => d.accountId))];
        const accounts = await db.account.findMany({
            where: { tenantId, accountId: { in: accountIds } },
            select: { accountId: true, name: true, regions: true, connectionStatus: true, active: true },
        });
        const accountMeta = new Map(accounts.map(a => [a.accountId, a]));

        // Aggregate deployment rows by account.
        const byAccount = new Map<string, typeof deployments>();
        for (const d of deployments) {
            if (!byAccount.has(d.accountId)) byAccount.set(d.accountId, []);
            byAccount.get(d.accountId)!.push(d);
        }

        const result = [...byAccount.entries()].map(([accountId, deps]) => {
            const meta = accountMeta.get(accountId);
            const expiries = deps.map(d => d.acmNotAfter).filter(Boolean) as string[];
            const earliestExpiry = expiries.length
                ? expiries.reduce((a, b) => (new Date(a) < new Date(b) ? a : b))
                : null;
            const lastScanned = deps
                .map(d => d.lastScannedAt)
                .filter(Boolean)
                .sort()
                .reverse()[0] ?? null;
            // Worst link state wins (error > missing > discovered > deployed).
            const order: Record<string, number> = { error: 3, missing: 2, discovered: 1, deployed: 0 };
            const linkState = deps.reduce(
                (worst, d) => (order[d.linkState] > order[worst] ? d.linkState : worst),
                'deployed'
            );

            return {
                accountId,
                accountName: meta?.name ?? accountId,
                active: meta?.active ?? false,
                connectionStatus: meta?.connectionStatus ?? 'unknown',
                regions: deps.map(d => d.region).filter(r => r !== 'unknown'),
                acmNotAfter: earliestExpiry,
                linkState,
                lastScannedAt: lastScanned,
                resourceCount: deps.reduce((sum, d) => sum + d.inUseByCount, 0),
                deployments: deps.map(d => ({
                    region: d.region,
                    acmArn: d.acmArn,
                    acmNotAfter: d.acmNotAfter,
                    acmStatus: d.acmStatus,
                    linkState: d.linkState,
                    inUseByCount: d.inUseByCount,
                })),
            };
        });

        return NextResponse.json({ success: true, data: { accounts: result } });
    } catch (error: unknown) {
        console.error('Error fetching certificate accounts:', error);
        const message = error instanceof Error ? error.message : 'Failed to fetch accounts';
        return NextResponse.json({ success: false, error: message }, { status: 500 });
    }
}
