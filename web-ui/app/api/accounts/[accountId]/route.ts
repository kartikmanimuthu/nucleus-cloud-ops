import { NextRequest, NextResponse } from 'next/server';
import { AccountService } from '@/lib/account-service';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../auth/[...nextauth]/route';
import { getSessionTenantId } from '@/lib/auth-session';

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ accountId: string }> }
) {
    try {
        const { accountId } = await params;
        console.log('API - GET /api/accounts/[accountId] - Fetching account:', accountId);

        const tenantId = await getSessionTenantId();
        const account = await AccountService.getAccount(accountId, tenantId);

        if (!account) {
            return NextResponse.json({
                success: false,
                error: 'Account not found'
            }, { status: 404 });
        }

        console.log('API - Successfully fetched account:', accountId);
        return NextResponse.json({
            success: true,
            data: account
        });
    } catch (error) {
        console.error('API - Error fetching account:', error);
        return NextResponse.json({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to fetch account'
        }, { status: 500 });
    }
}

export async function PUT(
    request: NextRequest,
    { params }: { params: Promise<{ accountId: string }> }
) {
    try {
        const { accountId } = await params;
        console.log('API - PUT /api/accounts/[accountId] - Updating account:', accountId);

        const session = await getServerSession(authOptions);
        const updatedBy = session?.user?.email || 'api-user';
        const tenantId = await getSessionTenantId();

        // Pre-flight ownership check (D-03)
        const existing = await AccountService.getAccount(accountId, tenantId);
        if (!existing) {
            return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 });
        }

        const updateData = await request.json();
        console.log('API - Update data:', updateData, 'User:', updatedBy);

        await AccountService.updateAccount(accountId, { ...updateData, updatedBy }, tenantId);

        console.log('API - Successfully updated account:', accountId);
        return NextResponse.json({
            success: true,
            message: 'Account updated successfully'
        });
    } catch (error) {
        console.error('API - Error updating account:', error);
        return NextResponse.json({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to update account'
        }, { status: 500 });
    }
}

export async function DELETE(
    request: NextRequest,
    { params }: { params: Promise<{ accountId: string }> }
) {
    try {
        const { accountId } = await params;
        console.log('API - DELETE /api/accounts/[accountId] - Deleting account:', accountId);

        const session = await getServerSession(authOptions);
        const deletedBy = session?.user?.email || 'api-user';
        const tenantId = await getSessionTenantId();
        console.log('API - Deleting user:', deletedBy);

        // Pre-flight ownership check (D-03)
        const existing = await AccountService.getAccount(accountId, tenantId);
        if (!existing) {
            return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 });
        }

        await AccountService.deleteAccount(accountId, deletedBy, tenantId);

        console.log('API - Successfully deleted account:', accountId);
        return NextResponse.json({
            success: true,
            message: 'Account deleted successfully'
        });
    } catch (error) {
        console.error('API - Error deleting account:', error);
        return NextResponse.json({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to delete account'
        }, { status: 500 });
    }
}
