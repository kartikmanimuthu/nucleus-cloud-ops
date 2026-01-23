import { NextRequest, NextResponse } from 'next/server';
import { AuditService } from '@/lib/audit-service';

// GET /api/accounts/[accountId]/activity - Get recent activity logs for this account
export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ accountId: string }> }
) {
    try {
        const { accountId } = await params;

        if (!accountId) {
            return NextResponse.json(
                { error: 'Account ID is required' },
                { status: 400 }
            );
        }

        const decodedAccountId = decodeURIComponent(accountId);

        // Fetch audit logs filtered by accountId or resource containing the accountId
        // We'll search for schedule execution events and account-related actions
        const { logs } = await AuditService.getAuditLogs({
            limit: 50, // Get recent 50 activities
        });

        // Filter logs that are related to this account
        const accountLogs = logs.filter((log) => {
            // Check if the accountId matches
            if (log.accountId === decodedAccountId) return true;

            // Check if metadata contains the accountId
            if (log.metadata?.accountId === decodedAccountId) return true;

            // Check if resource contains the accountId (for schedule-related logs)
            if (log.resourceId?.includes(decodedAccountId)) return true;

            return false;
        });

        // Transform to activity format for the UI
        const activity = accountLogs.map((log) => ({
            id: log.id,
            timestamp: log.timestamp,
            action: log.action,
            details: log.details,
            status: log.status,
            resourceType: log.resourceType,
            resourceName: log.resource,
            metadata: log.metadata,
        }));

        return NextResponse.json({
            activity,
            total: activity.length,
            accountId: decodedAccountId,
        });
    } catch (error: any) {
        console.error('Error fetching activity for account:', error);
        return NextResponse.json(
            { error: error.message || 'Failed to fetch activity' },
            { status: 500 }
        );
    }
}
