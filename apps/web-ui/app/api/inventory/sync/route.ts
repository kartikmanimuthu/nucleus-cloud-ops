import { NextRequest, NextResponse } from 'next/server';
import { AuditService } from '@/lib/audit-service';
import { randomUUID } from 'crypto';
import { getSessionTenantId } from '@/lib/auth-session';
import { getBoss } from '@/lib/boss-client';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';

/**
 * POST /api/inventory/sync
 * Trigger manual discovery sync for a specific account or all accounts via pg-boss.
 */
export async function POST(request: NextRequest) {
    try {
        const body = await request.json().catch(() => ({}));
        const accountId = body.accountId as string | undefined;
        const scanId = randomUUID();
        const tenantId = await getSessionTenantId();
        const session = await getServerSession(authOptions);
        const userEmail = session?.user?.email ?? '';

        // Log scan initiation
        await AuditService.logResourceAction({
            eventType: 'inventory.sync.triggered',
            severity: 'medium',
            apiRoute: 'POST /api/inventory/sync',
            httpMethod: 'POST',
            action: 'scan_triggered',
            resourceType: 'discovery',
            resourceId: scanId,
            resourceName: accountId ? `Scan ${accountId}` : 'Full Scan',
            status: 'success',
            tenantId,
            details: accountId
                ? `triggered manual discovery scan for account ${accountId}`
                : 'triggered manual discovery scan for all accounts',
            source: 'platform',
            metadata: {
                accountId: accountId || 'ALL',
                scanId,
            },
        });

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
                singletonKey: accountId
                    ? `tenant:${tenantId}:account:${accountId}`
                    : `tenant:${tenantId}`,
                retryLimit: 2,
                retryDelay: 60,
                retryBackoff: true,
            }
        );

        if (!jobId) {
            await AuditService.logResourceAction({
                eventType: 'inventory.sync.triggered',
                severity: 'medium',
                apiRoute: 'POST /api/inventory/sync',
                httpMethod: 'POST',
                action: 'scan_failed',
                resourceType: 'discovery',
                resourceId: scanId,
                resourceName: accountId ? `Scan ${accountId}` : 'Full Scan',
                status: 'error',
                tenantId,
                details: 'Failed to enqueue discovery job: pg-boss returned null (job may already be queued)',
                source: 'platform',
                metadata: {
                    accountId: accountId || 'ALL',
                    scanId,
                },
            });

            return NextResponse.json(
                { error: 'Failed to trigger discovery: job already queued or enqueue failed' },
                { status: 500 }
            );
        }

        console.log(`API - POST /api/inventory/sync - Triggered scan for tenant ${tenantId}`, { jobId, scanId, accountId });

        return NextResponse.json({
            success: true,
            message: accountId
                ? `Discovery sync triggered for account ${accountId}`
                : 'Discovery sync triggered for all accounts',
            jobId,
            scanId,
            startedAt: new Date().toISOString(),
        });

    } catch (error: any) {
        console.error('Error triggering discovery sync:', error);
        return NextResponse.json(
            { error: error.message || 'Failed to trigger sync' },
            { status: 500 }
        );
    }
}
