import { NextRequest, NextResponse } from 'next/server';
import { AccountService } from '@/lib/account-service';
import { authorize } from '@/lib/rbac/authorize';

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ accountId: string }> }
) {
    // Check authorization - validate action on Account subject
    const authError = await authorize('validate', 'Account');
    if (authError) return authError;

    try {
        const { accountId } = await params;
        console.log(`API - Validating account ${accountId}`);

        const result = await AccountService.validateAccount(accountId);

        return NextResponse.json({
            success: true,
            valid: result.connectionStatus === 'connected',
            data: result
        });
    } catch (error) {
        console.error('API - Error validating account:', error);
        return NextResponse.json({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to validate account'
        }, { status: 500 });
    }
}
