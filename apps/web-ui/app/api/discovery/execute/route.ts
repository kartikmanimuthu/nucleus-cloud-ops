import { NextRequest, NextResponse } from 'next/server';
import { authorize } from '@/lib/rbac/authorize';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../auth/[...nextauth]/route';
import { AuditService } from '@/lib/audit-service';
import { getBoss } from '@/lib/boss-client';

export async function POST(req: NextRequest) {
    const authError = await authorize('create', 'Resource');
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
                retryLimit: 2,
                retryDelay: 60,
                retryBackoff: true,
            }
        );

        if (!jobId) {
            return NextResponse.json(
                { success: false, error: 'A scan is already queued or running for this tenant' },
                { status: 409 }
            );
        }

        console.log(`API - POST /api/discovery/execute - Triggered scan for tenant ${tenantId}`, { jobId, accountId });

        // Audit: log discovery scan trigger
        AuditService.logUserAction({
            eventType: 'inventory.discovery.triggered',
            severity: 'medium',
            apiRoute: 'POST /api/discovery/execute',
            httpMethod: 'POST',
            action: 'inventory.discovery.triggered',
            resourceType: 'inventory',
            resourceId: jobId,
            resourceName: 'Discovery Scan',
            user: userEmail || 'unknown',
            userType: 'user',
            status: 'success',
            details: `Triggered discovery scan for tenant ${tenantId}${accountId ? ` account ${accountId}` : ''}`,
            metadata: { tenantId, jobId, accountId },
        }).catch(() => {});

        return NextResponse.json({ success: true, jobId });
    } catch (error) {
        console.error('API - Error triggering discovery scan:', error);
        return NextResponse.json({ success: false, error: 'Failed to trigger scan' }, { status: 500 });
    }
}
