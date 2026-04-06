import { NextRequest, NextResponse } from 'next/server';
import { getTenantClient, getPrismaClient } from '@/lib/db/pg-config';
import { getSessionTenantId } from '@/lib/auth-session';

interface AccountSyncStatus {
    accountId: string;
    accountName: string;
    lastSyncedAt?: string;
    lastSyncStatus?: 'success' | 'failed' | 'running' | 'never';
    lastSyncResourceCount?: number;
    lastSyncDurationMs?: number;
    syncEnabled?: boolean;
}

/**
 * Derive live stats from inventory_resources table via Prisma.
 */
async function getLiveStats(tenantId: string): Promise<{
    totalResources: number;
    accountsSynced: number;
    lastDiscoveredAt: string | null;
}> {
    const db = getTenantClient(tenantId);
    const [totalResources, accountGroups, latest] = await Promise.all([
        db.inventoryResource.count(),
        db.inventoryResource.groupBy({ by: ['accountId'], _count: { accountId: true } }),
        db.inventoryResource.findFirst({ orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } }),
    ]);
    return {
        totalResources,
        accountsSynced: accountGroups.length,
        lastDiscoveredAt: latest?.updatedAt?.toISOString() ?? null,
    };
}

/**
 * GET /api/inventory/status
 * Get inventory sync status including:
 * - Latest sync info (scanId, totalResources, accountsSynced, syncedAt)
 * - Account-level sync status (optional, by accountId param)
 */
export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const accountId = searchParams.get('accountId');
        const tenantId = await getSessionTenantId();

        // Latest sync from inventory_sync_status table (no tenantId column — global scan metadata)
        const prisma = getPrismaClient();
        const latestSyncRow = await prisma.inventorySyncStatus.findFirst({
            orderBy: { syncedAt: 'desc' },
        });

        const latestSync = latestSyncRow ? {
            scanId: latestSyncRow.scanId,
            totalResources: latestSyncRow.totalResources,
            accountsSynced: latestSyncRow.accountsSynced,
            syncedAt: latestSyncRow.syncedAt.toISOString(),
            status: latestSyncRow.status,
        } : null;

        // Account-level sync status from accounts table
        const db = getTenantClient(tenantId);
        let accounts: AccountSyncStatus[] = [];

        if (accountId) {
            const acc = await db.account.findFirst({ where: { accountId } });
            if (acc) {
                accounts.push({
                    accountId: acc.accountId,
                    accountName: acc.name,
                    lastSyncedAt: acc.lastSyncedAt?.toISOString(),
                    lastSyncStatus: acc.lastSyncedAt ? 'success' : 'never',
                    lastSyncResourceCount: acc.lastSyncResourceCount ?? undefined,
                    syncEnabled: acc.active,
                });
            }
        } else {
            const accs = await db.account.findMany({
                select: {
                    accountId: true,
                    name: true,
                    lastSyncedAt: true,
                    lastSyncResourceCount: true,
                    active: true,
                },
            });
            accounts = accs.map(acc => ({
                accountId: acc.accountId,
                accountName: acc.name,
                lastSyncedAt: acc.lastSyncedAt?.toISOString(),
                lastSyncStatus: acc.lastSyncedAt ? 'success' : 'never',
                lastSyncResourceCount: acc.lastSyncResourceCount ?? undefined,
                syncEnabled: acc.active,
            }));
        }

        const { totalResources, accountsSynced, lastDiscoveredAt } = await getLiveStats(tenantId);

        return NextResponse.json({
            latestSync,
            totalResources,
            accountsSynced,
            lastSyncedAt: latestSync?.syncedAt || lastDiscoveredAt || null,
            accounts,
            accountCount: accounts.length,
        });

    } catch (error: unknown) {
        console.error('Error fetching sync status:', error);
        const message = error instanceof Error ? error.message : 'Failed to fetch sync status';
        return NextResponse.json(
            { error: message },
            { status: 500 }
        );
    }
}
