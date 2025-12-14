import { NextRequest, NextResponse } from 'next/server';
import { AccountService } from '@/lib/account-service';

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ accountId: string }> }
) {
    try {
        const accountId = (await params).accountId;
        console.log(`API - Scanning resources for account ${accountId}`);

        const resources = await AccountService.scanResources(accountId);

        return NextResponse.json({
            success: true,
            data: resources,
        });
    } catch (error: any) {
        console.error(`API - Error scanning account ${request.url}:`, error);
        return NextResponse.json(
            {
                success: false,
                error: error.message || 'Failed to scan resources',
            },
            { status: 500 }
        );
    }
}
