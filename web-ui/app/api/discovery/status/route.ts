import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../auth/[...nextauth]/route';
import { getPrismaClient } from '@/lib/db/pg-config';

export async function GET(req: NextRequest) {
    const authError = await authorize('read', 'Discovery');
    if (authError) return authError;

    try {
        const session = await getServerSession(authOptions);
        const tenantId = (session?.user as any)?.tenantId as string;

        if (!tenantId) {
            return NextResponse.json({ success: false, error: 'No tenant context' }, { status: 403 });
        }

        const prisma = getPrismaClient();

        const syncStatuses = await prisma.inventorySyncStatus.findMany({
            orderBy: { syncedAt: 'desc' },
            take: 10,
        });

        console.log(`API - GET /api/discovery/status - Fetched sync status`);

        return NextResponse.json({ success: true, data: syncStatuses });
    } catch (error) {
        console.error('API - Error fetching discovery status:', error);
        return NextResponse.json({ success: false, error: 'Failed to fetch status' }, { status: 500 });
    }
}
