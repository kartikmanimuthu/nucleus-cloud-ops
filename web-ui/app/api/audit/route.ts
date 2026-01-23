// API route for fetching audit logs
import { NextRequest, NextResponse } from 'next/server';
import { AuditService, AuditLogFilters } from '@/lib/audit-service';
import { getDynamoDBDocumentClient, AUDIT_TABLE_NAME } from '@/lib/aws-config';
import { DeleteCommand } from '@aws-sdk/lib-dynamodb';

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);

        // Build filters from query parameters
        const filters: AuditLogFilters = {};

        if (searchParams.get('startDate')) filters.startDate = searchParams.get('startDate')!;
        if (searchParams.get('endDate')) filters.endDate = searchParams.get('endDate')!;
        if (searchParams.get('eventType')) filters.eventType = searchParams.get('eventType')!;
        if (searchParams.get('status')) filters.status = searchParams.get('status')!;
        if (searchParams.get('severity')) filters.severity = searchParams.get('severity')!;
        if (searchParams.get('userType')) filters.userType = searchParams.get('userType')!;
        if (searchParams.get('resourceType')) filters.resourceType = searchParams.get('resourceType')!;
        if (searchParams.get('user')) filters.user = searchParams.get('user')!;
        if (searchParams.get('correlationId')) filters.correlationId = searchParams.get('correlationId')!;
        if (searchParams.get('executionId')) filters.executionId = searchParams.get('executionId')!;
        if (searchParams.get('resourceId')) filters.resourceId = searchParams.get('resourceId')!;
        if (searchParams.get('ipAddress')) filters.ipAddress = searchParams.get('ipAddress')!;
        if (searchParams.get('source')) filters.source = searchParams.get('source')!;
        if (searchParams.get('limit')) filters.limit = parseInt(searchParams.get('limit')!);
        if (searchParams.get('nextPageToken')) filters.nextPageToken = searchParams.get('nextPageToken')!;

        console.log('API - Fetching audit logs with filters:', filters);

        const { logs, nextPageToken } = await AuditService.getAuditLogs(filters);

        return NextResponse.json({
            success: true,
            data: logs,
            nextPageToken,
            count: logs.length,
        });
    } catch (error: unknown) {
        console.error('API - Error fetching audit logs:', error);
        return NextResponse.json(
            {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to fetch audit logs',
            },
            { status: 500 }
        );
    }
}

export async function POST(request: NextRequest) {
    try {
        const auditData = await request.json();

        // Extract user info from headers (if available)
        const userAgent = request.headers.get('user-agent') || 'Unknown';
        const ipAddress = request.headers.get('x-forwarded-for') ||
            request.headers.get('x-real-ip') ||
            'unknown';

        // Add audit log
        await AuditService.createAuditLog({
            ...auditData,
            userAgent,
            ipAddress,
            source: 'web-ui',
        });

        return NextResponse.json({
            success: true,
            message: 'Audit log created successfully',
        });
    } catch (error: unknown) {
        console.error('API - Error creating audit log:', error);
        return NextResponse.json(
            {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to create audit log',
            },
            { status: 500 }
        );
    }
}

export async function DELETE(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const id = searchParams.get('id');
        // pk and sk logic in delete command is needed, 
        // but 'name' was used as pk previously.
        // In new schema: pk = LOG#<id>, sk=<???> 
        // We probably need timestamp to delete it because it's the SK.
        // For now, let's assume we pass full Keys or skip DELETE since audit logs usually are immutable/TTL'd.

        // Actually, let's just error 501 Not Implemented or try to find it via GSI then delete?
        // Deleting audit logs is generally bad practice.
        // But for completeness, let's implement if we have the keys.
        // The old code passed 'name'. In new code, we need timestamp (SK).

        const timestamp = searchParams.get('timestamp');

        if (!id || !timestamp) {
            return NextResponse.json(
                {
                    success: false,
                    error: 'Missing required parameters: id and timestamp',
                },
                { status: 400 }
            );
        }

        console.log('API - Deleting audit log:', { id, timestamp });

        const command = new DeleteCommand({
            TableName: AUDIT_TABLE_NAME,
            Key: {
                pk: `LOG#${id}`,
                sk: timestamp
            }
        });

        await getDynamoDBDocumentClient().send(command);

        return NextResponse.json({
            success: true,
            message: 'Audit log deleted successfully',
        });
    } catch (error: unknown) {
        console.error('API - Error deleting audit log:', error);
        return NextResponse.json(
            {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to delete audit log',
            },
            { status: 500 }
        );
    }
}
