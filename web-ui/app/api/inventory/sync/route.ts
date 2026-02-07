import { NextRequest, NextResponse } from 'next/server';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { AuditService } from '@/lib/audit-service';
import { randomUUID } from 'crypto';

const eventBridgeClient = new EventBridgeClient({
    region: process.env.AWS_REGION || 'ap-south-1',
});

/**
 * POST /api/inventory/sync
 * Trigger manual discovery sync for a specific account or all accounts via EventBridge
 */
export async function POST(request: NextRequest) {
    try {
        const body = await request.json().catch(() => ({}));
        const accountId = body.accountId as string | undefined;
        const scanId = randomUUID();

        // Log scan initiation
        await AuditService.logResourceAction({
            action: 'scan_triggered',
            resourceType: 'discovery',
            resourceId: scanId,
            resourceName: accountId ? `Scan ${accountId}` : 'Full Scan',
            status: 'success',
            details: accountId
                ? `triggered manual discovery scan for account ${accountId}`
                : 'triggered manual discovery scan for all accounts',
            source: 'web-ui',
            metadata: {
                accountId: accountId || 'ALL',
                scanId
            }
        });

        const command = new PutEventsCommand({
            Entries: [
                {
                    Source: 'nucleus.app',
                    DetailType: 'StartDiscovery',
                    Detail: JSON.stringify({
                        scanId,
                        accountId,
                    }),
                    EventBusName: 'default',
                },
            ],
        });

        const result = await eventBridgeClient.send(command);

        if (result.FailedEntryCount && result.FailedEntryCount > 0) {
            const failures = result.Entries?.filter(e => e.ErrorCode).map(e => `${e.ErrorCode}: ${e.ErrorMessage}`).join(', ') || 'Unknown error';

            // Log failure
            await AuditService.logResourceAction({
                action: 'scan_failed',
                resourceType: 'discovery',
                resourceId: scanId,
                resourceName: accountId ? `Scan ${accountId}` : 'Full Scan',
                status: 'error',
                details: `Failed to trigger EventBridge event: ${failures}`,
                source: 'web-ui',
                metadata: {
                    accountId: accountId || 'ALL',
                    scanId,
                    failures
                }
            });

            return NextResponse.json(
                { error: `Failed to trigger discovery event: ${failures}` },
                { status: 500 }
            );
        }

        return NextResponse.json({
            success: true,
            message: accountId
                ? `Discovery sync triggered for account ${accountId}`
                : 'Discovery sync triggered for all accounts',
            eventId: result.Entries?.[0]?.EventId,
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

