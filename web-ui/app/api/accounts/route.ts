import { NextRequest, NextResponse } from 'next/server';
import { AccountService } from '@/lib/account-service';
import { getServerSession } from 'next-auth';
import { authOptions } from '../auth/[...nextauth]/route';
import { authorize } from '@/lib/rbac/authorize';

export async function GET(request: NextRequest) {
    // Authorization check
    const authError = await authorize('read', 'Account');
    if (authError) return authError;

    try {
        console.log('API - GET /api/accounts - Fetching accounts');

        // Extract query parameters
        const { searchParams } = new URL(request.url);
        const statusFilter = searchParams.get('status') || undefined;
        const connectionFilter = searchParams.get('connection') || undefined;
        const searchTerm = searchParams.get('search') || undefined;
        const limit = searchParams.get('limit') ? parseInt(searchParams.get('limit')!) : undefined;
        const page = searchParams.get('page') ? parseInt(searchParams.get('page')!) : 1;

        const filters = {
            statusFilter,
            connectionFilter,
            searchTerm,
            limit,
            page
        };

        const result = await AccountService.getAccounts(filters);

        return NextResponse.json({
            success: true,
            data: result.accounts,
            totalCount: result.totalCount
        });
    } catch (error) {
        console.error('API - Error fetching accounts:', error);
        return NextResponse.json({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to fetch accounts'
        }, { status: 500 });
    }
}

export async function POST(request: NextRequest) {
    // Authorization check - create requires manage permission
    const authError = await authorize('create', 'Account');
    if (authError) return authError;

    try {
        console.log('API - POST /api/accounts - Creating account');

        const session = await getServerSession(authOptions);
        const createdBy = session?.user?.email || 'api-user';

        const accountData = await request.json();
        console.log('API - Account data:', accountData, 'User:', createdBy);

        await AccountService.createAccount({
            ...accountData,
            createdBy: accountData.createdBy || createdBy,
            updatedBy: accountData.updatedBy || createdBy
        });

        console.log('API - Successfully created account');
        return NextResponse.json({
            success: true,
            message: 'Account created successfully'
        });
    } catch (error) {
        console.error('API - Error creating account:', error);
        return NextResponse.json({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to create account'
        }, { status: 500 });
    }
}
