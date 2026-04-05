import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../auth/[...nextauth]/route';
import { getBoss } from '@/lib/boss-client';

export async function POST(req: NextRequest) {
    const authError = await authorize('create', 'Discovery');
    if (authError) return authError;

    try {
        const session = await getServerSession(authOptions);
        const tenantId = (session?.user as any)?.tenantId as string;
        const userEmail = session?.user?.email as string;

        if (!tenantId) {
            return NextResponse.json({ success: false, error: 'No tenant context' }, { status: 403 });
        }

        const body = await req.json().catch(() => ({}));
        const { accountId } = body as { accountId?: string };

        const boss = await getBoss();
        const jobId = await boss.send(
            'discovery-scan',
            {
                type: 'scan' as const,
                tenantId,
                accountId,
                triggeredBy: 'web-ui' as const,
                userEmail,
            },
            {
                singletonKey: `tenant:${tenantId}`,
                expireInHours: 2,
                retryLimit: 2,
                retryDelay: 60,
                retryBackoff: true,
            }
        );

        console.log(`API - POST /api/discovery/execute - Triggered scan for tenant ${tenantId}`, { jobId, accountId });

        return NextResponse.json({ success: true, jobId });
    } catch (error) {
        console.error('API - Error triggering discovery scan:', error);
        return NextResponse.json({ success: false, error: 'Failed to trigger scan' }, { status: 500 });
    }
}
