import { NextRequest, NextResponse } from 'next/server';
import { AccountService } from '@/lib/account-service';
import { getSessionTenantId } from '@/lib/auth-session';
import type { RouteAuthz } from '@nucleus/rbac';

/** Layer 1 permission declaration — see lib/rbac/rbac-allowlist.ts for the public set. */
export const authz: RouteAuthz = {
    GET: { action: 'read', subject: 'Resource' },
};

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ accountId: string }> }
) {
    try {
        const accountId = (await params).accountId;
        console.log(`API - Scanning resources for account ${accountId}`);

        const tenantId = await getSessionTenantId();
        const resources = await AccountService.scanResources(accountId, tenantId);

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
