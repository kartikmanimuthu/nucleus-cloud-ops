import { NextRequest, NextResponse } from 'next/server';
import { AccountService } from '@/lib/account-service';
import type { RouteAuthz } from '@nucleus/rbac';

/** Layer 1 permission declaration — see lib/rbac/rbac-allowlist.ts for the public set. */
export const authz: RouteAuthz = {
    POST: { action: 'validate', subject: 'Account' },
};

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { roleArn, externalId, region } = body;

        console.log(`API - Validating credentials for ${roleArn} (ExternalID: ${externalId ? 'Provided' : 'None'})`);

        if (!roleArn || !region) {
            return NextResponse.json({
                success: false,
                error: 'Missing required parameters: roleArn, region'
            }, { status: 400 });
        }

        // Use the new validateCredentials method
        const result = await AccountService.validateCredentials({
            roleArn,
            externalId,
            region
        });

        return NextResponse.json({
            success: true,
            data: {
                isValid: result.isValid,
                error: result.error
            }
        });
    } catch (error) {
        console.error('API - Error validating credentials:', error);
        return NextResponse.json({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to validate credentials'
        }, { status: 500 });
    }
}
